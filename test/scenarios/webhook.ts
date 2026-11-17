import { readFileSync } from "node:fs";
import { check, mux, same } from "../lib.ts";
import type { Scenario } from "../scenario.ts";

let squatterId: string | undefined;
const base = (run: string) => `https://example.com/alchemy-mux/${run}`;

export const webhook: Scenario = {
  name: "webhook",
  stack: "MuxVerifyWebhook",
  stackFile: "test/stacks/webhook.run.ts",
  resources: { hook: (a) => `/system/v1/webhooks/${a.id}` },
  matchesMux: {
    hook: async (a) =>
      same("hook", a, (await mux("GET", `/system/v1/webhooks/${a.id}`)).data, ["address", "enabled"]),
  },
  phases: [
    {
      name: "create",
      plan: { hook: "create" },
      verify: async ({ run, state }) => {
        const live = await mux("GET", `/system/v1/webhooks/${state.hook!.id}`);
        check(live.status === 200, "webhook missing in Mux after create");
        check(live.data.address === `${base(run)}/a`, `address is ${live.data.address}`);
        check(live.data.enabled === true, "new webhook should be enabled");
        check(state.hook!.signing_secret.length >= 16, "signing_secret was not captured at create");
      },
    },
    {
      name: "update",
      plan: { hook: "update" },
      verify: async ({ run, state, previous }) => {
        check(state.hook!.id === previous.hook!.id, "update replaced the webhook");
        check(
          state.hook!.signing_secret === previous.hook!.signing_secret,
          "signing_secret changed or was lost on update",
        );
        const live = await mux("GET", `/system/v1/webhooks/${state.hook!.id}`);
        check(live.data.address === `${base(run)}/b`, `address is ${live.data.address}`);
        check(live.data.enabled === false, "enabled: false was not applied");
      },
    },
    {
      name: "conflict",
      plan: {},
      failsWith: "already exists in this environment",
      before: async ({ run }) => {
        const created = await mux("POST", "/system/v1/webhooks", { address: `${base(run)}/taken` });
        check(created.status === 201, `could not create squatter webhook: ${created.status}`);
        squatterId = created.data.id;
      },
      verify: async ({ run, state }) => {
        const live = await mux("GET", `/system/v1/webhooks/${state.hook!.id}`);
        check(live.data.address === `${base(run)}/b`, "failed update still changed the webhook");
      },
    },
    {
      name: "lookup",
      plan: { hook: "update" },
      verify: async ({ state }) => {
        const live = await mux("GET", `/system/v1/webhooks/${state.hook!.id}`);
        check(live.data.enabled === true, "re-enable was not applied");
        const output = JSON.parse(
          readFileSync(`.alchemy/state/MuxVerifyWebhook/${process.env.VERIFY_STAGE}/__stack_output__.json`, "utf8"),
        );
        check(JSON.stringify(output).includes(squatterId!), `lookup did not return ${squatterId}`);
      },
      after: async () => {
        if (squatterId) await mux("DELETE", `/system/v1/webhooks/${squatterId}`);
      },
    },
    {
      name: "drift",
      plan: { hook: "create" },
      detectDrift: true,
      before: async ({ previous }) => {
        const del = await mux("DELETE", `/system/v1/webhooks/${previous.hook!.id}`);
        check(del.status === 204, `out-of-band delete returned ${del.status}`);
      },
      verify: async ({ run, state, previous }) => {
        check(state.hook!.id !== previous.hook!.id, "drift repair did not create a new webhook");
        const live = await mux("GET", `/system/v1/webhooks/${state.hook!.id}`);
        check(live.data?.address === `${base(run)}/b`, "recreated webhook has wrong address");
        check(state.hook!.signing_secret.length >= 16, "recreated webhook has no signing secret");
      },
    },
  ],
};
