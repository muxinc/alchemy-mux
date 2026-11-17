import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Mux from "../../src/index.ts";

const run = process.env.MUX_TEST_RUN!;
const phase = process.env.MUX_TEST_PHASE!;
const base = `https://example.com/alchemy-mux/${run}`;

const props: Record<string, Mux.WebhookProps> = {
  create: { address: `${base}/a` },
  update: { address: `${base}/b`, enabled: false },
  conflict: { address: `${base}/taken` },
  lookup: { address: `${base}/b`, enabled: true },
  drift: { address: `${base}/b`, enabled: true },
};

export default Alchemy.Stack(
  "MuxVerifyWebhook",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const hook = yield* Mux.Webhook("hook", props[phase]);
    const external = phase === "lookup" ? Mux.Webhook.lookup({ address: `${base}/taken` }) : undefined;
    return { hookId: hook.id, externalId: external?.id };
  }),
);
