import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Mux from "../../src/index.ts";

const run = process.env.MUX_TEST_RUN!;
const phase = process.env.MUX_TEST_PHASE!;
const phases = ["create", "update", "reenable", "retitle", "retarget", "replace"];
const at = (name: string) => phases.indexOf(phase) >= phases.indexOf(name);

export default Alchemy.Stack(
  "MuxVerifyLiveStream",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const vocab = yield* Mux.TranscriptionVocabulary("vocab", {
      name: `verify ${run}`,
      phrases: at("update") ? ["Alchemy", "Mux", run] : ["Alchemy"],
    });

    const stream = yield* Mux.LiveStream("stream", {
      playback_policies: at("replace") ? ["signed"] : ["public"],
      // Not a test stream: Mux rejects simulcast targets on test streams. It never receives video.
      test: false,
      passthrough: run,
      latency_mode: at("update") ? "reduced" : "low",
      meta: { title: at("retitle") ? `verify ${run} v3` : at("update") ? `verify ${run} v2` : `verify ${run}` },
      new_asset_settings: {
        playback_policies: ["public"],
        video_quality: at("update") ? "premium" : "plus",
      },
      ...(at("update") && {
        reconnect_window: 30,
        embedded_subtitles: [{ language_code: "en", language_channel: "cc1" as const }],
      }),
      ...(phase === "update" && {
        enabled: false,
        generated_subtitles: [
          { language_code: "en" as const, transcription_vocabulary_ids: [vocab.id] },
        ],
      }),
    });

    const target = yield* Mux.SimulcastTarget("target", {
      live_stream_id: stream.id,
      url: at("retarget") ? "rtmp://example.com/live-b" : "rtmp://example.com/live-a",
      stream_key: Redacted.make(`key-${run}`),
    });

    return { streamId: stream.id, vocabId: vocab.id, targetId: target.id };
  }),
);
