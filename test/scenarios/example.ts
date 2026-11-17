import { check, mux } from "../lib.ts";
import type { Scenario } from "../scenario.ts";

export const example: Scenario = {
  name: "example",
  stack: "MuxExample",
  stackFile: "example/alchemy.run.ts",
  resources: {
    moderation: (a) => `/robots/v1/directives/${a.id}`,
    hero: (a) => `/video/v1/assets/${a.id}`,
    speakers: (a) => `/video/v1/transcription-vocabularies/${a.id}`,
    stage: (a) => `/video/v1/live-streams/${a.id}`,
    playback: (a) => `/system/v1/signing-keys/${a.id}`,
    "site-only": (a) => `/video/v1/playback-restrictions/${a.id}`,
    events: (a) => `/system/v1/webhooks/${a.id}`,
    release: (a) => `/data/v1/annotations/${a.id}`,
  },
  retained: ["release"],
  isGone: {
    playback: async (a) => {
      const keys = (await mux("GET", "/system/v1/signing-keys?limit=100")).data;
      return !keys.some((k: { id: string }) => k.id === a.id);
    },
  },
  phases: [
    {
      name: "create",
      plan: {
        moderation: "create",
        hero: "create",
        speakers: "create",
        stage: "create",
        playback: "create",
        "site-only": "create",
        events: "create",
        release: "create",
      },
      verify: async ({ state }) => {
        check(state.hero!.status === "ready", "example hero asset not ready");
        check(state.hero!.signed_playback_id, "example hero has no signed playback id");
        const stage = (await mux("GET", `/video/v1/live-streams/${state.stage!.id}`)).data;
        check(
          stage.generated_subtitles?.[0]?.transcription_vocabulary_ids?.includes(state.speakers!.id),
          "example live captions do not use the vocabulary",
        );
      },
    },
  ],
};
