import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Mux from "../../src/index.ts";

const run = process.env.MUX_TEST_RUN!;
const phase = process.env.MUX_TEST_PHASE!;
const phases = ["create", "update", "trim", "captions", "recaption", "badtrack", "halfway", "revert", "drift", "unset", "redirect", "watermark", "reingest", "badinput"];
const at = (name: string) => phases.indexOf(phase) >= phases.indexOf(name);
const between = (from: string, to: string) => at(from) && !at(to);

export const DEMO_URL = "https://storage.googleapis.com/muxdemofiles/mux.mp4";
const FR_VTT = "https://tears-of-steel-subtitles.s3.amazonaws.com/tears-fr.vtt";
const EN_VTT = "https://tears-of-steel-subtitles.s3.amazonaws.com/tears-en.vtt";
const WATERMARK = "https://muxed.s3.amazonaws.com/example-watermark.png";

export default Alchemy.Stack(
  "MuxVerifyAsset",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const directive = yield* Mux.Robots.Directive("directive", {
      name: at("redirect") ? `verify ${run} moderation v2` : `verify ${run} moderation`,
      bindings: [{ reference_id: "moderation", workflow: "moderate" }],
    });

    const asset = yield* Mux.Asset("asset", {
      inputs: [
        {
          url: DEMO_URL,
          ...(between("captions", "recaption") && {
            generated_subtitles: [{ language_code: "en" as const, name: "English (generated)" }],
          }),
        },
        ...(at("captions")
          ? [
              {
                url: phase === "badtrack" ? `https://example.com/alchemy-mux/${run}/missing.vtt` : at("recaption") ? EN_VTT : FR_VTT,
                type: "text" as const,
                text_type: "subtitles" as const,
                language_code: "fr",
                name: "Français",
              },
              { url: DEMO_URL, type: "audio" as const, language_code: "es", name: "Español" },
            ]
          : []),
        ...(at("watermark")
          ? [{ url: WATERMARK, overlay_settings: { horizontal_align: "right" as const, width: "10%" } }]
          : []),
      ],
      test: true,
      video_quality: at("reingest") ? "plus" : "basic",
      passthrough: at("update") ? `${run}-v2` : run,
      ...(!between("unset", "redirect") && {
        meta: {
          title: phase === "halfway" ? `verify ${run} halfway` : at("update") ? `verify ${run} v2` : `verify ${run}`,
        },
      }),
      directives: [{ id: directive.id }],
      playback_policies: between("update", "trim")
        ? ["public", "signed"]
        : at("trim")
          ? ["signed"]
          : ["public"],
      // Mux rejects this resolution, after the title change has been applied.
      ...(phase === "halfway" && { static_renditions: [{ resolution: "999p" as "highest" }] }),
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
