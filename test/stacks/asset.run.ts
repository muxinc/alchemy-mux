import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Mux from "../../src/index.ts";

const run = process.env.MUX_TEST_RUN!;
const phase = process.env.MUX_TEST_PHASE!;
const phases = ["create", "update", "trim", "redirect", "reingest", "badinput"];
const at = (name: string) => phases.indexOf(phase) >= phases.indexOf(name);
const between = (from: string, to: string) => at(from) && !at(to);

export const DEMO_URL = "https://storage.googleapis.com/muxdemofiles/mux.mp4";

export default Alchemy.Stack(
  "MuxVerifyAsset",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const directive = yield* Mux.Robots.Directive("directive", {
      name: at("redirect") ? `verify ${run} moderation v2` : `verify ${run} moderation`,
      bindings: [{ reference_id: "moderation", workflow: "moderate" }],
    });

    const asset = yield* Mux.Asset("asset", {
      inputs: [{ url: DEMO_URL }],
      test: true,
      video_quality: at("reingest") ? "plus" : "basic",
      passthrough: at("update") ? `${run}-v2` : run,
      meta: { title: at("update") ? `verify ${run} v2` : `verify ${run}` },
      directives: [{ id: directive.id }],
      playback_policies: between("update", "trim")
        ? ["public", "signed"]
        : at("trim")
          ? ["signed"]
          : ["public"],
      ...(between("update", "trim") && {
        thumbnail_time: 2,
        master_access: "temporary" as const,
        static_renditions: [{ resolution: "highest" as const }],
      }),
    });

    if (phase === "badinput") {
      yield* Mux.Asset("broken", {
        inputs: [{ url: `https://example.com/alchemy-mux/${run}/missing.mp4` }],
        test: true,
        passthrough: `${run}-broken`,
      });
    }

    return { assetId: asset.id, directiveId: directive.id };
  }),
);
