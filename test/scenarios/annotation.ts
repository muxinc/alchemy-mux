import { check, mux, same } from "../lib.ts";
import type { Scenario } from "../scenario.ts";
import { pinnedDate } from "../stacks/annotation.run.ts";

const annotation = async (id: string) => (await mux("GET", `/data/v1/annotations/${id}`)).data;

export const annotation_: Scenario = {
  name: "annotation",
  stack: "MuxVerifyAnnotation",
  stackFile: "test/stacks/annotation.run.ts",
  resources: {
    marker: (a) => `/data/v1/annotations/${a.id}`,
    pinned: (a) => `/data/v1/annotations/${a.id}`,
    kept: (a) => `/data/v1/annotations/${a.id}`,
  },
  retained: ["kept"],
  matchesMux: Object.fromEntries(
    ["marker", "pinned", "kept"].map((id) => [
      id,
      async (a: Record<string, any>) => same(id, a, await annotation(a.id), ["note", "date"]),
    ]),
  ),
  phases: [
    {
      name: "create",
      plan: { marker: "create", pinned: "create", kept: "create" },
      verify: async ({ run, state }) => {
        const marker = await annotation(state.marker!.id);
        check(marker.note === `verify ${run} v1`, `note is ${marker.note}`);
        const age = Date.now() / 1000 - Date.parse(marker.date) / 1000;
        check(age >= -60 && age < 600, `default date is ${marker.date}, not deploy time`);
        const pinned = await annotation(state.pinned!.id);
        check(Date.parse(pinned.date) / 1000 === pinnedDate(run), `pinned date is ${pinned.date}`);
      },
    },
    {
      name: "renote",
      plan: { marker: "replace", pinned: "noop", kept: "replace" },
      verify: async ({ run, state, previous }) => {
        check(state.marker!.id !== previous.marker!.id, "note change did not create a new marker");
        check((await annotation(state.marker!.id)).note === `verify ${run} v2`, "new marker note wrong");
        const old = await mux("GET", `/data/v1/annotations/${previous.marker!.id}`);
        check(old.status === 404, "replaced marker was not deleted");
        check(state.kept!.id !== previous.kept!.id, "retained annotation was not replaced");
        const oldKept = await mux("GET", `/data/v1/annotations/${previous.kept!.id}`);
        check(oldKept.status === 200, "RemovalPolicy.retain() did not keep the previous marker");
      },
    },
  ],
};
