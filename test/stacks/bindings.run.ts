import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Mux from "../../src/index.ts";

const run = process.env.MUX_TEST_RUN!;

export default Alchemy.Stack(
  "MuxVerifyBindings",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const key = yield* Mux.SigningKey("key");
    const asset = yield* Mux.Asset("asset", {
      inputs: [{ url: "https://storage.googleapis.com/muxdemofiles/mux.mp4" }],
      test: true,
      video_quality: "basic",
      playback_policies: ["signed"],
      passthrough: run,
    });
    const hook = yield* Mux.Webhook("hook", { address: `https://example.com/alchemy-mux/${run}/hook` });
    return { key: key.id, asset: asset.id, hook: hook.id };
  }),
);
