import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Mux from "../../src/index.ts";

const phase = process.env.MUX_TEST_PHASE!;

const restriction: Record<string, Mux.PlaybackRestrictionProps> = {
  create: { referrer: { allowed_domains: ["example.com"] } },
  update: {
    referrer: { allowed_domains: ["example.com", "*.example.com"], allow_no_referrer: true },
    user_agent: { allow_no_user_agent: false, allow_high_risk_user_agent: false },
  },
};
restriction.drift = restriction.update!;

export default Alchemy.Stack(
  "MuxVerifyAccess",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const key = yield* Mux.SigningKey("key");
    const rule = yield* Mux.PlaybackRestriction("restriction", restriction[phase]);
    return { keyId: key.id, restrictionId: rule.id };
  }),
);
