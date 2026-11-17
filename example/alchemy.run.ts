import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Mux from "../src/index.ts";

export default Alchemy.Stack(
  "MuxExample",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const moderation = yield* Mux.Robots.Directive("moderation", {
      name: "Moderate new uploads",
      bindings: [{ reference_id: "moderation", workflow: "moderate" }],
    });

    const hero = yield* Mux.Asset("hero", {
      inputs: [{ url: "https://storage.googleapis.com/muxdemofiles/mux.mp4" }],
      test: true,
      video_quality: "basic",
      playback_policies: ["signed"],
      meta: { title: "Homepage hero" },
      directives: [{ id: moderation.id }],
    });

    const vocab = yield* Mux.TranscriptionVocabulary("speakers", { phrases: ["Mux", "Alchemy"] });
    const stage = yield* Mux.LiveStream("stage", {
      playback_policies: ["public"],
      latency_mode: "reduced",
      test: true,
      meta: { title: "Main stage" },
      generated_subtitles: [{ language_code: "en", transcription_vocabulary_ids: [vocab.id] }],
    });

    const key = yield* Mux.SigningKey("playback");
    const restriction = yield* Mux.PlaybackRestriction("site-only", {
      referrer: { allowed_domains: ["example.com", "*.example.com"] },
    });
    const events = yield* Mux.Webhook("events", { address: "https://example.com/mux/webhooks" });

    yield* Mux.Annotation("release", { note: `Deployed ${process.env.GIT_SHA ?? "locally"}` }).pipe(
      RemovalPolicy.retain(),
    );

    // In a Worker or Lambda handler:
    //   const signer = yield* Mux.PlaybackSigner(key);
    //   const verifier = yield* Mux.WebhookVerifier(events);
    //   .pipe(Effect.provide(Mux.PlaybackSignerLive), Effect.provide(Mux.WebhookVerifierLive))

    return {
      heroPlaybackId: hero.signed_playback_id,
      stageRtmps: stage.rtmps_url,
      signingKeyId: key.id,
      restrictionId: restriction.id,
      webhookId: events.id,
    };
  }),
);
