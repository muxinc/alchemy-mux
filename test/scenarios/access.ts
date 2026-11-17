import { createPrivateKey } from "node:crypto";
import { check, mux, same } from "../lib.ts";
import type { Scenario } from "../scenario.ts";

export const access: Scenario = {
  name: "access",
  stack: "MuxVerifyAccess",
  stackFile: "test/stacks/access.run.ts",
  resources: {
    key: (a) => `/system/v1/signing-keys/${a.id}`,
    restriction: (a) => `/video/v1/playback-restrictions/${a.id}`,
  },
  isGone: {
    key: async (a) => {
      const keys = (await mux("GET", "/system/v1/signing-keys?limit=100")).data;
      const del = await mux("DELETE", `/system/v1/signing-keys/${a.id}`);
      return !keys.some((k: { id: string }) => k.id === a.id) && del.status === 404;
    },
  },
  matchesMux: {
    restriction: async (a) =>
      same(
        "restriction",
        a,
        (await mux("GET", `/video/v1/playback-restrictions/${a.id}`)).data,
        ["referrer", "user_agent"],
      ),
  },
  phases: [
    {
      name: "create",
      plan: { key: "create", restriction: "create" },
      verify: async ({ state }) => {
        const pem = Buffer.from(state.key!.private_key, "base64").toString("utf8");
        const key = createPrivateKey(pem);
        check(key.asymmetricKeyType === "rsa", "private_key is not an RSA key");
        check((await mux("GET", `/system/v1/signing-keys/${state.key!.id}`)).status === 200, "key missing in Mux");
        const live = (await mux("GET", `/video/v1/playback-restrictions/${state.restriction!.id}`)).data;
        check(
          JSON.stringify(live.referrer.allowed_domains) === '["example.com"]',
          `referrer is ${JSON.stringify(live.referrer)}`,
        );
      },
    },
    {
      name: "update",
      plan: { key: "noop", restriction: "update" },
      verify: async ({ state, previous }) => {
        check(state.restriction!.id === previous.restriction!.id, "update replaced the restriction");
        check(state.key!.private_key === previous.key!.private_key, "signing key changed");
        const live = (await mux("GET", `/video/v1/playback-restrictions/${state.restriction!.id}`)).data;
        check(
          JSON.stringify(live.referrer.allowed_domains) === '["example.com","*.example.com"]',
          `referrer is ${JSON.stringify(live.referrer)}`,
        );
        check(live.referrer.allow_no_referrer === true, "allow_no_referrer not applied");
        check(live.user_agent.allow_no_user_agent === false, "allow_no_user_agent not applied");
        check(live.user_agent.allow_high_risk_user_agent === false, "allow_high_risk_user_agent not applied");
      },
    },
    {
      name: "drift",
      plan: { key: "create", restriction: "noop" },
      detectDrift: true,
      before: async ({ previous }) => {
        const del = await mux("DELETE", `/system/v1/signing-keys/${previous.key!.id}`);
        check(del.status === 204, `out-of-band delete returned ${del.status}`);
      },
      verify: async ({ state, previous }) => {
        check(state.key!.id !== previous.key!.id, "drift repair did not create a new key");
        const keys = (await mux("GET", "/system/v1/signing-keys?limit=100")).data;
        check(keys.some((k: { id: string }) => k.id === state.key!.id), "recreated key missing in Mux");
        createPrivateKey(Buffer.from(state.key!.private_key, "base64").toString("utf8"));
      },
    },
  ],
};
