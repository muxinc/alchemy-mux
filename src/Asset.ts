import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { metaWrite } from "./Converge.ts";
import { listAll, Mux, playbackIdsByPolicy, type PlaybackIdsByPolicy, sortPlaybackIds } from "./Api.ts";
import type { components } from "./generated/mux-api.ts";
import type { Providers } from "./Providers.ts";

type Schemas = components["schemas"];
type MuxAsset = Schemas["Asset"];
type Input = Schemas["InputSettings"];
type Track = Schemas["Track"];
type GeneratedSubtitles = Schemas["AssetGeneratedSubtitleSettings"];

/**
 * Field names match the Mux API. Deprecated fields (`input`,
 * `playback_policy`, `mp4_support`, `encoding_tier`) are omitted.
 */
export type AssetProps = Omit<
  Schemas["AssetOptions"],
  "input" | "playback_policy" | "mp4_support" | "encoding_tier"
> & {
  /** Seconds into the video for the default thumbnail. */
  thumbnail_time?: number;
  /**
   * Wait during deploy until Mux finishes ingesting, and fail the deploy if
   * ingest errors (the errored asset is deleted). Defaults to `true`.
   */
  wait_for_ready?: boolean;
};

export type AssetAttributes = MuxAsset & { playback_ids: Schemas["PlaybackID"][] } & PlaybackIdsByPolicy;

export type Asset = Resource<"Mux.Asset", AssetProps, AssetAttributes, never, Providers>;

/**
 * A Mux video asset ingested from a URL: hero and marketing videos, demo
 * content, seed data for preview environments.
 * @see https://www.mux.com/docs/core/stream-video-files
 *
 * These update in place: `passthrough`, `meta`, `thumbnail_time`,
 * `master_access`, `static_renditions` (renditions are added and removed),
 * `playback_policies` (playback IDs are added and removed), `directives`
 * (newly listed Directives run on the existing asset), and text and audio
 * tracks: every `text` and `audio` input, plus the first input's
 * `generated_subtitles`. Any other change, including the video input or a
 * watermark (overlay) input, creates a new asset, which means ingesting and
 * encoding the video again.
 *
 * Updates compare the props with the asset as Mux reports it, so a deploy
 * after a failed one finishes or reverts the half-applied change, and
 * `alchemy deploy --detect-drift` repairs settings changed outside Alchemy,
 * including declared tracks deleted outside it. Playback IDs are managed
 * only when `playback_policies` or `advanced_playback_policies` is set.
 *
 * A removed track is found by its type, language and name, because Mux does
 * not report a track's source URL. Give tracks that share a type and
 * language distinct names; Mux also requires names to be unique per asset.
 * A changed track is removed before its replacement is added. If a new track
 * errors, the deploy fails and the asset's tracks are put back as they were.
 *
 * **Example:** A hero video with AI captions, French subtitles and an MP4 download
 * ```typescript
 * const hero = yield* Mux.Asset("hero", {
 *   inputs: [
 *     { url: "https://example.com/hero.mp4", generated_subtitles: [{ language_code: "en" }] },
 *     { url: "https://example.com/hero-fr.vtt", type: "text", text_type: "subtitles", language_code: "fr", name: "Français" },
 *   ],
 *   playback_policies: ["public"],
 *   video_quality: "plus",
 *   static_renditions: [{ resolution: "highest" }],
 *   meta: { title: "Homepage hero" },
 *   directives: [{ id: captions.id }],
 * });
 * // hero.public_playback_id -> https://stream.mux.com/{id}.m3u8
 * ```
 *
 * @resource
 */
export const Asset = Resource<Asset>("Mux.Asset");

/** Mux could not ingest the input. The errored asset has been deleted. */
export class AssetIngestFailed extends Data.TaggedError("AssetIngestFailed")<{
  readonly id: string;
  readonly reason: string;
}> {
  override get message() {
    return `Mux could not ingest asset ${this.id}: ${this.reason}`;
  }
}

/** A track added to an existing asset errored. The tracks added in that deploy were removed. */
export class AssetTrackFailed extends Data.TaggedError("AssetTrackFailed")<{
  readonly id: string;
  readonly track: string;
}> {
  override get message() {
    return `Mux could not add the ${this.track} to asset ${this.id}. The tracks added in this deploy were removed.`;
  }
}

/** Several tracks match a removed input, so the provider cannot tell which to delete. */
export class AssetTrackAmbiguous extends Data.TaggedError("AssetTrackAmbiguous")<{
  readonly id: string;
  readonly track: string;
}> {
  override get message() {
    return `Asset ${this.id} has several tracks matching the removed ${this.track}. Give tracks that share a type and language distinct names.`;
  }
}

/** Raised if the engine asks to update a field Mux only sets at creation. */
export class AssetImmutableChange extends Data.TaggedError("AssetImmutableChange")<{
  readonly id: string;
}> {
  override get message() {
    return `Asset ${this.id} has a change to a field Mux only sets at creation; it must be replaced.`;
  }
}

/**
 * Props Mux can change on an existing asset. Changing any other prop, or
 * the video and watermark inputs, creates a new asset.
 */
export const AssetUpdatable: ReadonlySet<string> = new Set([
  "passthrough",
  "meta",
  "thumbnail_time",
  "master_access",
  "static_renditions",
  "playback_policies",
  "directives",
  "inputs",
  "wait_for_ready",
] satisfies (keyof AssetProps)[]);

const plan = (olds: AssetProps, news: AssetProps): "replace" | "update" | undefined => {
  let action: "update" | undefined;
  const keys = new Set([...Object.keys(olds), ...Object.keys(news)]) as Set<keyof AssetProps>;
  for (const key of keys) {
    if (isResolved(news[key]) && deepEqual(olds[key], news[key])) continue;
    if (!AssetUpdatable.has(key)) return "replace";
    if (key === "inputs" && !sameSource(olds.inputs, news.inputs)) return "replace";
    action = "update";
  }
  return action;
};

const isTrack = (input: Input) => input.type === "text" || input.type === "audio";

/**
 * The video and any watermark (overlay) inputs are the source, which only a
 * new asset can change. Text and audio inputs, and the video's generated
 * subtitles, are tracks.
 */
const splitInputs = (inputs: Input[] | undefined) => {
  const [first, ...rest] = inputs ?? [];
  const { generated_subtitles, ...video } = first ?? {};
  return {
    source: [video, ...rest.filter((i) => !isTrack(i))],
    subtitles: generated_subtitles ?? [],
    tracks: rest.filter(isTrack),
  };
};

const sameSource = (olds: Input[] | undefined, news: Input[] | undefined) =>
  isResolved(news) && deepEqual(splitInputs(olds).source, splitInputs(news).source);

/** Items of `items` left after removing one deep-equal match per item of `remove`. */
const without = <T>(items: T[], remove: T[]) => {
  const rest = [...remove];
  return items.filter((item) => {
    const i = rest.findIndex((r) => deepEqual(r, item));
    if (i >= 0) rest.splice(i, 1);
    return i < 0;
  });
};

const describe = (t: { type?: string; language_code?: string; name?: string }) =>
  `${t.type ?? "text"} track ${t.language_code ?? ""}${t.name ? ` "${t.name}"` : ""}`.trim();

const matchesInput = (input: Input) => (t: Track) =>
  (t.type === "text" ? t.text_source === "uploaded" : t.type === "audio" && t.primary !== true) &&
  t.type === input.type &&
  t.language_code === input.language_code &&
  (t.type !== "text" || (t.text_type ?? "subtitles") === (input.text_type ?? "subtitles")) &&
  (input.name === undefined || t.name === input.name);

const matchesGenerated = (settings: GeneratedSubtitles) => (t: Track) =>
  t.text_source === "generated_vod" &&
  (settings.language_code === undefined || settings.language_code === "auto" || t.language_code === settings.language_code) &&
  (settings.name === undefined || t.name === settings.name);

const POLL_INTERVAL = Duration.seconds(2);
const READY_TIMEOUT = Duration.minutes(30);

const toAttrs = (asset: MuxAsset): AssetAttributes => {
  const playback_ids = sortPlaybackIds(asset.playback_ids);
  return { ...asset, playback_ids, ...playbackIdsByPolicy(playback_ids) };
};

const directiveIds = (props: AssetProps | undefined) => (props?.directives ?? []).map((d) => d.id);

export const AssetProvider = () =>
  Provider.effect(
    Asset,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (id: string) => `/video/v1/assets/${id}`;
      const get = (id: string) => mux.request<MuxAsset>("GET", path(id));

      const waitForReady = (id: string) =>
        Effect.gen(function* () {
          for (;;) {
            const asset = yield* get(id);
            const settled = !asset.tracks?.some((t) => t.status === "preparing");
            if (asset.status === "ready" && settled) {
              const failed = asset.tracks?.find((t) => t.status === "errored");
              if (!failed) return asset;
              yield* mux.request("DELETE", path(id)).pipe(Effect.ignore);
              return yield* new AssetIngestFailed({ id, reason: `the ${describe(failed)} errored` });
            }
            if (asset.status === "errored") {
              yield* mux.request("DELETE", path(id)).pipe(Effect.ignore);
              const reason = asset.errors?.messages?.join("; ") ?? asset.errors?.type ?? "unknown error";
              return yield* new AssetIngestFailed({ id, reason });
            }
            yield* Effect.sleep(POLL_INTERVAL);
          }
        }).pipe(Effect.timeout(READY_TIMEOUT));

      const applyTracks = (asset: MuxAsset, olds: AssetProps | undefined, news: AssetProps) =>
        Effect.gen(function* () {
          const before = splitInputs(olds?.inputs);
          const after = splitInputs(news.inputs);
          const existing = (asset.tracks ?? []).filter((t) => t.id);
          const claimed = new Set<string>();
          const unclaimed = (matches: (t: Track) => boolean) =>
            existing.filter((t) => !claimed.has(t.id!) && matches(t));

          const audio = existing.find((t) => t.type === "audio" && t.primary) ?? existing.find((t) => t.type === "audio");
          const addTrack = (input: Input) => mux.request<Track>("POST", `${path(asset.id)}/tracks`, input);
          const generate = (subtitles: GeneratedSubtitles[]) =>
            audio
              ? mux.request<Track[]>("POST", `${path(asset.id)}/tracks/${audio.id}/generate-subtitles`, {
                  generated_subtitles: subtitles,
                })
              : Effect.fail(new AssetTrackFailed({ id: asset.id, track: "generated subtitles (the asset has no audio)" }));

          // Each removed track carries the request that recreates it, for rollback.
          const doomed: { id: string; restore: Effect.Effect<unknown, unknown> }[] = [];
          const removals = [
            ...without(before.tracks, after.tracks).map((i) => [describe(i), matchesInput(i), addTrack(i)] as const),
            ...without(before.subtitles, after.subtitles).map(
              (s) => [describe({ ...s, name: s.name ?? "generated" }), matchesGenerated(s), generate([s])] as const,
            ),
          ];
          for (const [label, matches, restore] of removals) {
            const found = unclaimed(matches);
            if (found.length > 1) return yield* new AssetTrackAmbiguous({ id: asset.id, track: label });
            for (const t of found) {
              claimed.add(t.id!);
              doomed.push({ id: t.id!, restore });
            }
          }

          // Every declared track Mux does not have is added, so a track deleted
          // outside Alchemy, or lost to an interrupted deploy, comes back.
          const missing = (matches: (t: Track) => boolean) => {
            const present = unclaimed(matches)[0];
            if (present) claimed.add(present.id!);
            return present === undefined;
          };
          const addedInputs = after.tracks.filter((i) => missing(matchesInput(i)));
          const addedSubtitles = after.subtitles.filter((s) => missing(matchesGenerated(s)));

          const removed: Effect.Effect<unknown, unknown>[] = [];
          const added: Track[] = [];
          yield* Effect.gen(function* () {
            // Mux requires unique track names, so a replaced track goes before its successor.
            for (const { id, restore } of doomed) {
              yield* mux
                .request("DELETE", `${path(asset.id)}/tracks/${id}`)
                .pipe(Effect.catchTag("NotFound", () => Effect.void));
              removed.push(restore);
            }
            for (const input of addedInputs) added.push(yield* addTrack(input));
            if (addedSubtitles.length > 0) added.push(...(yield* generate(addedSubtitles)));
            if (news.wait_for_ready === false || added.length === 0) return;
            for (;;) {
              const current = (yield* get(asset.id)).tracks ?? [];
              const mine = current.filter((t) => added.some((a) => a.id === t.id));
              const failed = mine.find((t) => t.status === "errored");
              if (failed) return yield* new AssetTrackFailed({ id: asset.id, track: describe(failed) });
              if (!mine.some((t) => t.status === "preparing")) return;
              yield* Effect.sleep(POLL_INTERVAL);
            }
          }).pipe(
            Effect.timeout(READY_TIMEOUT),
            Effect.onError(() =>
              Effect.gen(function* () {
                for (const t of added) {
                  yield* mux.request("DELETE", `${path(asset.id)}/tracks/${t.id}`).pipe(Effect.ignore);
                }
                for (const restore of removed) yield* restore.pipe(Effect.ignore);
              }),
            ),
          );
        });

      /** Brings the asset to what `news` describes, comparing with Mux rather than with `olds`. */
      const converge = (asset: MuxAsset, olds: AssetProps | undefined, news: AssetProps) =>
        Effect.gen(function* () {
          const patch: Record<string, unknown> = {};
          if ((news.passthrough ?? "") !== (asset.passthrough ?? "")) patch.passthrough = news.passthrough ?? "";
          const meta = metaWrite(news.meta, asset.meta);
          if (meta) patch.meta = meta;
          if (news.thumbnail_time !== undefined && news.thumbnail_time !== asset.thumbnail_time) {
            patch.thumbnail_time = news.thumbnail_time;
          }
          if (Object.keys(patch).length > 0) yield* mux.request("PATCH", path(asset.id), patch);
          if (news.thumbnail_time === undefined && asset.thumbnail_time !== undefined) {
            yield* mux.request("DELETE", `${path(asset.id)}/thumbnail-time`);
          }

          const masterAccess = news.master_access ?? "none";
          if (masterAccess !== (asset.master_access ?? "none")) {
            yield* mux.request("PUT", `${path(asset.id)}/master-access`, { master_access: masterAccess });
          }

          // Playback IDs are managed only when the props declare policies.
          if (news.playback_policies !== undefined || news.advanced_playback_policies !== undefined) {
            const wanted = [
              ...(news.playback_policies ?? []).map((policy) => ({ policy })),
              ...(news.advanced_playback_policies ?? []),
            ];
            const current = asset.playback_ids ?? [];
            for (const want of wanted) {
              if (!current.some((p) => p.policy === want.policy)) {
                yield* mux.request("POST", `${path(asset.id)}/playback-ids`, want);
              }
            }
            for (const id of current.filter((p) => !wanted.some((w) => w.policy === p.policy))) {
              yield* mux
                .request("DELETE", `${path(asset.id)}/playback-ids/${id.id}`)
                .pipe(Effect.catchTag("NotFound", () => Effect.void));
            }
          }

          const desired = news.static_renditions ?? [];
          const existing = (asset.static_renditions?.files ?? []).filter((f) => f.id);
          for (const rendition of desired) {
            if (!existing.some((f) => f.resolution === rendition.resolution)) {
              yield* mux.request("POST", `${path(asset.id)}/static-renditions`, rendition);
            }
          }
          for (const file of existing.filter((f) => !desired.some((r) => r.resolution === f.resolution))) {
            yield* mux
              .request("DELETE", `${path(asset.id)}/static-renditions/${file.id}`)
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
          }

          yield* applyTracks(asset, olds, news);

          // Runs are events, not state: only newly listed Directives start one,
          // and an adopted asset starts none.
          if (olds !== undefined) {
            const before = directiveIds(olds);
            for (const id of directiveIds(news).filter((d) => !before.includes(d))) {
              yield* mux.request("POST", `/robots/v1/directives/${id}/runs`, { asset_id: asset.id });
            }
          }
        });

      return {
        stables: ["id", "created_at"],
        list: () =>
          listAll<MuxAsset>(mux, "/video/v1/assets").pipe(Effect.map((assets) => assets.map(toAttrs))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          const action = plan(olds ?? {}, news as AssetProps);
          return action === undefined ? undefined : ({ action } as const);
        }),
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          if (output === undefined) {
            const { wait_for_ready, thumbnail_time, ...body } = news;
            const created = yield* mux.request<MuxAsset>("POST", "/video/v1/assets", body);
            const ready = wait_for_ready === false ? created : yield* waitForReady(created.id);
            if (thumbnail_time !== undefined) {
              yield* mux.request("PATCH", path(created.id), { thumbnail_time });
            }
            return toAttrs(thumbnail_time === undefined ? ready : yield* get(created.id));
          }
          if (olds !== undefined && plan(olds, news) === "replace") {
            return yield* new AssetImmutableChange({ id: output.id });
          }
          yield* converge(yield* get(output.id), olds, news);
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
