import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { listAll, Mux, playbackIdsByPolicy, type PlaybackIdsByPolicy, sortPlaybackIds } from "./Api.ts";
import type { components } from "./generated/mux-api.ts";
import type { Providers } from "./Providers.ts";

type Schemas = components["schemas"];
type MuxLiveStream = Schemas["LiveStream"];

export type PlaybackPolicy = Schemas["PlaybackPolicy"];

/**
 * Field names match the Mux API so its docs apply as written. Deprecated
 * fields (`playback_policy`, `low_latency`, `reduced_latency`) are omitted,
 * and simulcast targets are managed with {@link SimulcastTarget}.
 */
export type LiveStreamProps = Omit<
  Schemas["CreateLiveStreamRequest"],
  "playback_policy" | "low_latency" | "reduced_latency" | "simulcast_targets"
> & {
  /** `false` disables the stream so encoders cannot connect. Defaults to `true`. */
  enabled?: boolean;
};

export type LiveStreamAttributes = Omit<MuxLiveStream, "stream_key" | "srt_passphrase"> & {
  /** Secret. Anyone holding it can broadcast to this stream. */
  stream_key: Redacted.Redacted<string>;
  srt_passphrase: Redacted.Redacted<string>;
  playback_ids: Schemas["PlaybackID"][];
} & PlaybackIdsByPolicy & {
  /** RTMPS ingest endpoint; pair it with `stream_key`. */
  rtmps_url: string;
  /** SRT ingest endpoint; use `stream_key` as the stream ID and `srt_passphrase`. */
  srt_url: string;
};

export type LiveStream = Resource<
  "Mux.LiveStream",
  LiveStreamProps,
  LiveStreamAttributes,
  never,
  Providers
>;

/**
 * A Mux live stream: a persistent ingest endpoint and stream key that
 * records each broadcast as an asset.
 * @see https://www.mux.com/docs/guides/start-live-streaming
 *
 * Most settings update in place. `playback_policies`,
 * `advanced_playback_policies`, `audio_only`, `test`, and any
 * `new_asset_settings` field other than `mp4_support`, `master_access` and
 * `video_quality` are fixed at creation: changing them creates a new stream
 * with a new stream key.
 *
 * Mux does not allow `latency_mode: "low"` together with `generated_subtitles`.
 *
 * **Example:** Reduced-latency stream with live English captions
 * ```typescript
 * const vocab = yield* Mux.TranscriptionVocabulary("speakers", { phrases: ["Mux", "Alchemy"] });
 * const stream = yield* Mux.LiveStream("main-stage", {
 *   playback_policies: ["public"],
 *   latency_mode: "reduced",
 *   generated_subtitles: [{ language_code: "en", transcription_vocabulary_ids: [vocab.id] }],
 * });
 * ```
 *
 * @resource
 */
export const LiveStream = Resource<LiveStream>("Mux.LiveStream");

/** How a change to each field reaches Mux. Fields not listed force a replacement. */
const APPLY = {
  passthrough: "patch",
  latency_mode: "patch",
  reconnect_window: "patch",
  use_slate_for_standard_latency: "patch",
  reconnect_slate_url: "patch",
  max_continuous_duration: "patch",
  meta: "patch",
  new_asset_settings: "patch",
  generated_subtitles: "generated-subtitles",
  embedded_subtitles: "embedded-subtitles",
  enabled: "enabled",
} as const satisfies Partial<Record<keyof LiveStreamProps, string>>;

type Applied = (typeof APPLY)[keyof typeof APPLY];

const PATCHED = Object.keys(APPLY).filter((key) => APPLY[key as keyof typeof APPLY] === "patch");

const NEW_ASSET_UPDATABLE = ["mp4_support", "master_access", "video_quality"] as const;

const pick = (value: Record<string, unknown> | undefined, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value![key]]));

const omit = (value: Record<string, unknown> | undefined, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));

/** Which application paths a change needs, or `"replace"`. */
const plan = (olds: LiveStreamProps, news: LiveStreamProps): Set<Applied> | "replace" => {
  const needed = new Set<Applied>();
  const keys = new Set([...Object.keys(olds), ...Object.keys(news)]) as Set<keyof LiveStreamProps>;
  for (const key of keys) {
    if (isResolved(news[key]) && deepEqual(olds[key], news[key])) continue;
    const how = APPLY[key as keyof typeof APPLY];
    if (how === undefined) return "replace";
    if (
      key === "new_asset_settings" &&
      !deepEqual(
        omit(olds.new_asset_settings, NEW_ASSET_UPDATABLE),
        omit(news.new_asset_settings, NEW_ASSET_UPDATABLE),
      )
    ) {
      return "replace";
    }
    needed.add(how);
  }
  return needed;
};

/** Raised if the engine asks to update a field Mux only sets at creation. */
export class LiveStreamImmutableChange extends Data.TaggedError("LiveStreamImmutableChange")<{
  readonly id: string;
}> {
  override get message() {
    return `Live stream ${this.id} has a change to a field Mux only sets at creation; it must be replaced.`;
  }
}

const RTMPS_URL = "rtmps://global-live.mux.com:443/app";
const SRT_URL = "srt://global-live.mux.com:6001";

const toAttrs = (stream: MuxLiveStream): LiveStreamAttributes => ({
  ...stream,
  playback_ids: sortPlaybackIds(stream.playback_ids),
  ...playbackIdsByPolicy(stream.playback_ids ?? []),
  stream_key: Redacted.make(stream.stream_key),
  srt_passphrase: Redacted.make(stream.srt_passphrase ?? ""),
  rtmps_url: RTMPS_URL,
  srt_url: SRT_URL,
});

export const LiveStreamProvider = () =>
  Provider.effect(
    LiveStream,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (id: string) => `/video/v1/live-streams/${id}`;
      const get = (id: string) => mux.request<MuxLiveStream>("GET", path(id));

      const apply = (id: string, how: Applied, news: LiveStreamProps) => {
        switch (how) {
          case "patch": {
            const body = pick(news, PATCHED);
            const assetSettings = pick(news.new_asset_settings, NEW_ASSET_UPDATABLE);
            if (Object.keys(assetSettings).length > 0) body.new_asset_settings = assetSettings;
            else delete body.new_asset_settings;
            return mux.request("PATCH", path(id), body);
          }
          case "generated-subtitles":
            return mux.request("PUT", `${path(id)}/generated-subtitles`, {
              generated_subtitles: news.generated_subtitles ?? [],
            });
          case "embedded-subtitles":
            return mux.request("PUT", `${path(id)}/embedded-subtitles`, {
              embedded_subtitles: news.embedded_subtitles ?? [],
            });
          case "enabled":
            return mux.request("PUT", `${path(id)}/${news.enabled === false ? "disable" : "enable"}`);
        }
      };

      return {
        stables: ["id", "stream_key", "srt_passphrase", "rtmps_url", "srt_url"],
        list: () =>
          listAll<MuxLiveStream>(mux, "/video/v1/live-streams").pipe(
            Effect.map((streams) => streams.map(toAttrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          const needed = plan(olds ?? {}, news as LiveStreamProps);
          if (needed === "replace") return { action: "replace" } as const;
          return needed.size > 0 ? ({ action: "update" } as const) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          if (output === undefined) {
            const { enabled, ...body } = news;
            const created = yield* mux.request<MuxLiveStream>("POST", "/video/v1/live-streams", body);
            if (enabled === false) yield* apply(created.id, "enabled", news);
            return toAttrs(yield* get(created.id));
          }
          // Adopted streams have no prior props, so every path is applied.
          const needed =
            olds === undefined ? new Set(Object.values(APPLY)) : plan(olds, news);
          if (needed === "replace") return yield* new LiveStreamImmutableChange({ id: output.id });
          for (const how of needed) yield* apply(output.id, how, news);
          // PATCH and PUT responses omit fields such as playback_ids, so re-read.
          return toAttrs(yield* get(output.id));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* mux
            .request("DELETE", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get(output.id).pipe(
            Effect.map(toAttrs),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),
      };
    }),
  );
