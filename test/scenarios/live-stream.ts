import { check, mux, same } from "../lib.ts";
import type { Scenario } from "../scenario.ts";

const stream = async (id: string) => (await mux("GET", `/video/v1/live-streams/${id}`)).data;
const targetPath = (a: Record<string, any>) =>
  `/video/v1/live-streams/${a.live_stream_id}/simulcast-targets/${a.id}`;

export const liveStream: Scenario = {
  name: "live-stream",
  stack: "MuxVerifyLiveStream",
  stackFile: "test/stacks/live-stream.run.ts",
  resources: {
    stream: (a) => `/video/v1/live-streams/${a.id}`,
    vocab: (a) => `/video/v1/transcription-vocabularies/${a.id}`,
    target: targetPath,
  },
  matchesMux: {
    stream: async (a) =>
      same("stream", a, await stream(a.id), [
        "playback_ids",
        "status",
        "latency_mode",
        "reconnect_window",
        "meta",
        "passthrough",
        "generated_subtitles",
        "embedded_subtitles",
        "new_asset_settings",
      ]),
    vocab: async (a) =>
      same("vocab", a, (await mux("GET", `/video/v1/transcription-vocabularies/${a.id}`)).data, [
        "name",
        "phrases",
      ]),
    target: async (a) => same("target", a, (await mux("GET", targetPath(a))).data, ["url"]),
  },
  phases: [
    {
      name: "create",
      plan: { vocab: "create", stream: "create", target: "create" },
      verify: async ({ run, state }) => {
        const live = await stream(state.stream!.id);
        check(live.latency_mode === "low", `latency_mode is ${live.latency_mode}`);
        check(live.test !== true, "stream should not be a test stream");
        check(live.passthrough === run, "passthrough not applied");
        check(live.status === "idle", `status is ${live.status}`);
        check(live.new_asset_settings?.video_quality === "plus", "new_asset_settings not applied");
        check(live.playback_ids?.[0]?.policy === "public", "missing public playback id");
        check(state.stream!.stream_key === live.stream_key, "state stream_key differs from Mux");
        check(state.stream!.srt_passphrase === live.srt_passphrase, "state srt_passphrase differs");
        check(
          state.stream!.playback_ids[0]?.id === live.playback_ids[0].id,
          "state playback_ids differ from Mux",
        );
        const vocab = (await mux("GET", `/video/v1/transcription-vocabularies/${state.vocab!.id}`)).data;
        check(JSON.stringify(vocab.phrases) === '["Alchemy"]', `phrases are ${JSON.stringify(vocab.phrases)}`);
        const target = await mux("GET", targetPath(state.target!));
        check(target.status === 200, "simulcast target missing in Mux");
        check(target.data.url === "rtmp://example.com/live-a", `target url is ${target.data.url}`);
        check(!("stream_key" in state.target!), "target stream_key leaked into state attributes");
      },
    },
    {
      name: "update",
      plan: { vocab: "update", stream: "update", target: "noop" },
      verify: async ({ run, state, previous }) => {
        check(state.stream!.id === previous.stream!.id, "update replaced the stream");
        check(state.stream!.stream_key === previous.stream!.stream_key, "stream key rotated on update");
        check(
          JSON.stringify(state.stream!.playback_ids) === JSON.stringify(previous.stream!.playback_ids),
          "playback_ids lost or changed on update",
        );
        const live = await stream(state.stream!.id);
        check(live.latency_mode === "reduced", `latency_mode is ${live.latency_mode}`);
        check(live.reconnect_window === 30, `reconnect_window is ${live.reconnect_window}`);
        check(live.meta?.title === `verify ${run} v2`, `title is ${live.meta?.title}`);
        check(live.status === "disabled", `enabled: false gave status ${live.status}`);
        check(live.new_asset_settings?.video_quality === "premium", "video_quality update not applied");
        const generated = live.generated_subtitles?.[0];
        check(generated?.language_code === "en", "generated_subtitles not applied");
        check(
          generated?.transcription_vocabulary_ids?.includes(state.vocab!.id),
          "generated_subtitles does not reference the vocabulary",
        );
        check(live.embedded_subtitles?.[0]?.language_channel === "cc1", "embedded_subtitles not applied");
        const vocab = (await mux("GET", `/video/v1/transcription-vocabularies/${state.vocab!.id}`)).data;
        check(state.vocab!.id === previous.vocab!.id, "vocabulary was replaced instead of updated");
        check(vocab.phrases.includes(run), `phrases are ${JSON.stringify(vocab.phrases)}`);
      },
    },
    {
      name: "reenable",
      plan: { vocab: "noop", stream: "update", target: "noop" },
      verify: async ({ state }) => {
        const live = await stream(state.stream!.id);
        check(live.status === "idle", `re-enable gave status ${live.status}`);
        check(!live.generated_subtitles?.length, "removing generated_subtitles did not clear them");
        check(live.embedded_subtitles?.[0]?.language_channel === "cc1", "embedded_subtitles were lost");
      },
    },
    {
      name: "retitle",
      plan: { vocab: "noop", stream: "update", target: "noop" },
      verify: async ({ run, state, previous }) => {
        check(state.stream!.id === previous.stream!.id, "title change replaced the stream");
        const live = await stream(state.stream!.id);
        check(live.meta?.title === `verify ${run} v3`, `title is ${live.meta?.title}`);
      },
    },
    {
      name: "retarget",
      plan: { vocab: "noop", stream: "noop", target: "replace" },
      verify: async ({ state, previous }) => {
        check(state.target!.id !== previous.target!.id, "target url change did not replace the target");
        const target = await mux("GET", targetPath(state.target!));
        check(target.data?.url === "rtmp://example.com/live-b", `target url is ${target.data?.url}`);
        const old = await mux("GET", targetPath(previous.target!));
        check(old.status === 404, "old simulcast target was not deleted");
      },
    },
    {
      name: "replace",
      plan: { vocab: "noop", stream: "replace", target: "replace" },
      verify: async ({ state, previous }) => {
        check(state.stream!.id !== previous.stream!.id, "replace kept the old stream");
        const live = await stream(state.stream!.id);
        check(live.playback_ids?.[0]?.policy === "signed", "replacement lacks signed playback id");
        check(state.target!.live_stream_id === state.stream!.id, "target not moved to the new stream");
        check((await mux("GET", targetPath(state.target!))).status === 200, "new target missing");
        const old = await mux("GET", `/video/v1/live-streams/${previous.stream!.id}`);
        check(old.status === 404, "replaced stream was not deleted");
      },
    },
  ],
};
