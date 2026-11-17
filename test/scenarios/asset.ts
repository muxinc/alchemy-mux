import { check, mux, same } from "../lib.ts";
import type { Scenario } from "../scenario.ts";

const asset = async (id: string) => (await mux("GET", `/video/v1/assets/${id}`)).data;

/** Polls until the directive has a run for the asset; directive runs start asynchronously. */
async function runFor(directiveId: string, assetId: string) {
  for (let i = 0; i < 30; i++) {
    const runs = (await mux("GET", `/robots/v1/directives/${directiveId}/runs?limit=100`)).data ?? [];
    const run = runs.find((r: { subject_id: string }) => r.subject_id === assetId);
    if (run) return run;
    await Bun.sleep(2000);
  }
  return undefined;
}

const policies = (a: any) => (a.playback_ids ?? []).map((p: any) => p.policy).sort();
const idFor = (a: any, policy: string) => a.playback_ids?.find((p: any) => p.policy === policy)?.id;
const rendition = (a: any, resolution: string) =>
  a.static_renditions?.files?.find((f: any) => f.id && f.resolution === resolution);

export const asset_: Scenario = {
  name: "asset",
  stack: "MuxVerifyAsset",
  stackFile: "test/stacks/asset.run.ts",
  resources: {
    directive: (a) => `/robots/v1/directives/${a.id}`,
    asset: (a) => `/video/v1/assets/${a.id}`,
    broken: (a) => `/video/v1/assets/${a.id}`,
  },
  matchesMux: {
    asset: async (a) =>
      same("asset", a, await asset(a.id), [
        "status",
        "playback_ids",
        "meta",
        "passthrough",
        "master_access",
        "thumbnail_time",
        "video_quality",
        "test",
      ]),
    directive: async (a) =>
      same("directive", a, (await mux("GET", `/robots/v1/directives/${a.id}`)).data, ["name", "bindings"]),
  },
  phases: [
    {
      name: "create",
      plan: { directive: "create", asset: "create" },
      verify: async ({ run, state }) => {
        const live = await asset(state.asset!.id);
        check(live.status === "ready", `deploy returned before ready: status ${live.status}`);
        check(live.test === true, "asset should be a test asset");
        check(live.passthrough === run, "passthrough not applied");
        check(live.meta?.title === `verify ${run}`, `title is ${live.meta?.title}`);
        check(JSON.stringify(policies(live)) === '["public"]', `policies are ${policies(live)}`);
        check(state.asset!.public_playback_id === idFor(live, "public"), "public_playback_id attribute wrong");
        check(
          live.directives?.some((d: { id: string }) => d.id === state.directive!.id),
          "directive not attached to the asset",
        );
        check(await runFor(state.directive!.id, state.asset!.id), "attached directive never ran on the asset");
      },
    },
    {
      name: "update",
      plan: { directive: "noop", asset: "update" },
      verify: async ({ run, state, previous }) => {
        check(state.asset!.id === previous.asset!.id, "update re-ingested the asset");
        const live = await asset(state.asset!.id);
        check(live.meta?.title === `verify ${run} v2`, `title is ${live.meta?.title}`);
        check(live.passthrough === `${run}-v2`, "passthrough update not applied");
        check(live.thumbnail_time === 2, `thumbnail_time is ${live.thumbnail_time}`);
        check(live.master_access === "temporary", `master_access is ${live.master_access}`);
        check(rendition(live, "highest"), "static rendition 'highest' not created");
        check(JSON.stringify(policies(live)) === '["public","signed"]', `policies are ${policies(live)}`);
        check(
          idFor(live, "public") === idFor(previous.asset, "public"),
          "existing public playback id changed when adding signed",
        );
      },
    },
    {
      name: "trim",
      plan: { directive: "noop", asset: "update" },
      verify: async ({ state, previous }) => {
        check(state.asset!.id === previous.asset!.id, "trim re-ingested the asset");
        const live = await asset(state.asset!.id);
        check(JSON.stringify(policies(live)) === '["signed"]', `policies are ${policies(live)}`);
        check(state.asset!.public_playback_id === undefined, "public_playback_id kept after removal");
        check(state.asset!.signed_playback_id === idFor(live, "signed"), "signed_playback_id attribute wrong");
        check(idFor(live, "signed") === idFor(previous.asset, "signed"), "signed playback id changed");
        check(!rendition(live, "highest"), "static rendition 'highest' was not removed");
        check(live.master_access === "none", `master_access is ${live.master_access}`);
        check(live.thumbnail_time === undefined, `thumbnail_time is ${live.thumbnail_time}`);
      },
    },
    {
      name: "redirect",
      plan: { directive: "replace", asset: "update" },
      verify: async ({ state, previous }) => {
        check(state.directive!.id !== previous.directive!.id, "directive change did not create a new one");
        check(state.asset!.id === previous.asset!.id, "directive swap re-ingested the asset");
        const old = await mux("GET", `/robots/v1/directives/${previous.directive!.id}`);
        check(old.status === 404, "replaced directive was not deleted");
        check(await runFor(state.directive!.id, state.asset!.id), "new directive did not run on the existing asset");
      },
    },
    {
      name: "reingest",
      plan: { directive: "noop", asset: "replace" },
      verify: async ({ state, previous }) => {
        check(state.asset!.id !== previous.asset!.id, "video_quality change did not create a new asset");
        const live = await asset(state.asset!.id);
        check(live.status === "ready" && live.video_quality === "plus", "new asset not ready at plus");
        const old = await mux("GET", `/video/v1/assets/${previous.asset!.id}`);
        check(old.status === 404, "replaced asset was not deleted");
      },
    },
    {
      name: "badinput",
      plan: {},
      failsWith: "Mux could not ingest asset",
      verify: async ({ run, state }) => {
        check(state.broken === undefined, "a failed ingest was recorded in state");
        const recent = (await mux("GET", "/video/v1/assets?limit=50")).data ?? [];
        const orphans = recent.filter((a: { passthrough?: string }) => a.passthrough === `${run}-broken`);
        check(orphans.length === 0, `errored asset left in Mux: ${orphans.map((a: any) => a.id)}`);
      },
    },
  ],
};
