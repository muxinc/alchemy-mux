import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { matches, metaWrite } from "./Converge.ts";
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
 * `new_asset_settings` field other than `mp4_support`, `master_access`,
 * `video_quality` and `meta` are fixed at creation: changing them creates a
 * new stream with a new stream key.
 *
 * Updates compare the props with the stream as Mux reports it, so a deploy
 * after a failed one finishes or reverts the half-applied change, and
 * `alchemy deploy --detect-drift` repairs settings changed outside Alchemy. A setting removed from the props returns to Mux's default.
 *
 * Mux does not allow `latency_mode: "low"` together with `generated_subtitles`
 * or `embedded_subtitles`. When both change, captions are removed before the
 * latency changes.
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

/** Props Mux can change on an existing stream. Changing any other prop creates a new stream. */
export const LiveStreamUpdatable: ReadonlySet<string> = new Set([
  "passthrough",
  "latency_mode",
  "reconnect_window",
  "use_slate_for_standard_latency",
  "reconnect_slate_url",
  "max_continuous_duration",
  "meta",
  "new_asset_settings",
  "generated_subtitles",
  "embedded_subtitles",
  "enabled",
] satisfies (keyof LiveStreamProps)[]);

const NEW_ASSET_UPDATABLE = ["mp4_support", "master_access", "video_quality", "meta"];

const omit = (value: Record<string, unknown> | undefined, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));

const propsChanged = (olds: LiveStreamProps, news: LiveStreamProps) =>
  [...new Set([...Object.keys(olds), ...Object.keys(news)])].filter(
    (key) => !isResolved(news[key as keyof LiveStreamProps]) || !deepEqual(olds[key as keyof LiveStreamProps], news[key as keyof LiveStreamProps]),
  );

const replaces = (olds: LiveStreamProps, news: LiveStreamProps) =>
  propsChanged(olds, news).some(
    (key) =>
      !LiveStreamUpdatable.has(key) ||
      (key === "new_asset_settings" &&
        !deepEqual(omit(olds.new_asset_settings, NEW_ASSET_UPDATABLE), omit(news.new_asset_settings, NEW_ASSET_UPDATABLE))),
  );

/** What Mux holds for a PATCH field the props leave out; Mux omits these values from responses. */
const PATCH_DEFAULTS = {
  passthrough: "",
  latency_mode: "standard",
  reconnect_window: 60,
  use_slate_for_standard_latency: false,
  reconnect_slate_url: "",
  max_continuous_duration: 43200,
} as const;

type Pending = {
  patch: Record<string, unknown>;
  generated_subtitles?: LiveStreamProps["generated_subtitles"];
  embedded_subtitles?: LiveStreamProps["embedded_subtitles"];
  enabled?: boolean;
};

/** The writes that bring `live` to the state `news` describes, compared field by field. */
type Observed = Omit<Partial<MuxLiveStream>, "stream_key" | "srt_passphrase">;

const pending = (news: LiveStreamProps, live: Observed): Pending => {
  const patch: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(PATCH_DEFAULTS) as [keyof typeof PATCH_DEFAULTS, unknown][]) {
    // Test streams are fixed at a 300 second limit.
    const base = key === "max_continuous_duration" && news.test ? undefined : fallback;
    const want = news[key] ?? base;
    if (want !== undefined && !deepEqual(want, live[key] ?? base)) patch[key] = want;
  }
  const meta = metaWrite(news.meta, live.meta);
  if (meta) patch.meta = meta;

  const wantAsset = news.new_asset_settings ?? {};
  const haveAsset = live.new_asset_settings ?? {};
  const asset: Record<string, unknown> = {};
  for (const key of ["mp4_support", "master_access"] as const) {
    const want = wantAsset[key] ?? "none";
    if (want !== (haveAsset[key] ?? "none")) asset[key] = want;
  }
  if (wantAsset.video_quality !== undefined && wantAsset.video_quality !== haveAsset.video_quality) {
    asset.video_quality = wantAsset.video_quality;
  }
  const assetMeta = metaWrite(wantAsset.meta, haveAsset.meta);
  if (assetMeta) asset.meta = assetMeta;
  if (Object.keys(asset).length > 0) patch.new_asset_settings = asset;

  const generated = news.generated_subtitles ?? [];
  const embedded = news.embedded_subtitles ?? [];
  return {
    patch,
    ...(!matches(generated, live.generated_subtitles ?? []) && { generated_subtitles: generated }),
    ...(!matches(embedded, live.embedded_subtitles ?? []) && { embedded_subtitles: embedded }),
    ...((news.enabled === false) !== (live.status === "disabled") && { enabled: news.enabled !== false }),
  };
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

      const write = (id: string, p: Pending) =>
        Effect.gen(function* () {
          const subtitles = (key: "generated_subtitles" | "embedded_subtitles") =>
            p[key] === undefined
              ? Effect.void
              : mux.request("PUT", `${path(id)}/${key.replace("_", "-")}`, { [key]: p[key] });
          // Mux rejects low latency while captions are on, so captions are
          // removed before the PATCH and added after it.
          const removing = (key: "generated_subtitles" | "embedded_subtitles") => p[key]?.length === 0;
          if (removing("generated_subtitles")) yield* subtitles("generated_subtitles");
          if (removing("embedded_subtitles")) yield* subtitles("embedded_subtitles");
          if (Object.keys(p.patch).length > 0) yield* mux.request("PATCH", path(id), p.patch);
          if (!removing("generated_subtitles")) yield* subtitles("generated_subtitles");
          if (!removing("embedded_subtitles")) yield* subtitles("embedded_subtitles");
          if (p.enabled !== undefined) {
            yield* mux.request("PUT", `${path(id)}/${p.enabled ? "enable" : "disable"}`);
          }
        });

      return {
        stables: ["id", "stream_key", "srt_passphrase", "rtmps_url", "srt_url"],
        list: () =>
          listAll<MuxLiveStream>(mux, "/video/v1/live-streams").pipe(
            Effect.map((streams) => streams.map(toAttrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          const props = news as LiveStreamProps;
          if (replaces(olds ?? {}, props)) return { action: "replace" } as const;
          return propsChanged(olds ?? {}, props).length > 0 ? ({ action: "update" } as const) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          if (output === undefined) {
            const { enabled, ...body } = news;
            const created = yield* mux.request<MuxLiveStream>("POST", "/video/v1/live-streams", body);
            if (enabled === false) yield* write(created.id, { patch: {}, enabled: false });
            return toAttrs(yield* get(created.id));
          }
          if (olds !== undefined && replaces(olds, news)) {
            return yield* new LiveStreamImmutableChange({ id: output.id });
          }
          yield* write(output.id, pending(news, yield* get(output.id)));
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
