import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { listAll, Mux, playbackIdsByPolicy, type PlaybackIdsByPolicy, sortPlaybackIds } from "./Api.ts";
import type { components } from "./generated/mux-api.ts";
import type { Providers } from "./Providers.ts";

type Schemas = components["schemas"];
type MuxAsset = Schemas["Asset"];

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
 * `playback_policies` (playback IDs are added and removed), and
 * `directives` (newly listed Directives run on the existing asset). Any
 * other change creates a new asset, which means ingesting and encoding the
 * video again.
 *
 * **Example:** A hero video with an MP4 download and AI captions
 * ```typescript
 * const hero = yield* Mux.Asset("hero", {
 *   inputs: [{ url: "https://example.com/hero.mp4" }],
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

/** Raised if the engine asks to update a field Mux only sets at creation. */
export class AssetImmutableChange extends Data.TaggedError("AssetImmutableChange")<{
  readonly id: string;
}> {
  override get message() {
    return `Asset ${this.id} has a change to a field Mux only sets at creation; it must be replaced.`;
  }
}

/** How a change to each field reaches Mux. Fields not listed force a replacement. */
const APPLY = {
  passthrough: "patch",
  meta: "patch",
  thumbnail_time: "patch",
  master_access: "master-access",
  static_renditions: "static-renditions",
  playback_policies: "playback-ids",
  directives: "directives",
  wait_for_ready: "nothing",
} as const satisfies Partial<Record<keyof AssetProps, string>>;

type Applied = (typeof APPLY)[keyof typeof APPLY];

const plan = (olds: AssetProps, news: AssetProps): Set<Applied> | "replace" => {
  const needed = new Set<Applied>();
  const keys = new Set([...Object.keys(olds), ...Object.keys(news)]) as Set<keyof AssetProps>;
  for (const key of keys) {
    if (isResolved(news[key]) && deepEqual(olds[key], news[key])) continue;
    const how = APPLY[key as keyof typeof APPLY];
    if (how === undefined) return "replace";
    needed.add(how);
  }
  return needed;
};

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
            if (asset.status === "ready") return asset;
            if (asset.status === "errored") {
              yield* mux.request("DELETE", path(id)).pipe(Effect.ignore);
              const reason = asset.errors?.messages?.join("; ") ?? asset.errors?.type ?? "unknown error";
              return yield* new AssetIngestFailed({ id, reason });
            }
            yield* Effect.sleep(POLL_INTERVAL);
          }
        }).pipe(Effect.timeout(READY_TIMEOUT));

      const apply = (asset: MuxAsset, how: Applied, olds: AssetProps | undefined, news: AssetProps) =>
        Effect.gen(function* () {
          switch (how) {
            case "nothing":
              return;
            case "patch": {
              yield* mux.request("PATCH", path(asset.id), {
                passthrough: news.passthrough ?? "",
                meta: news.meta ?? {},
                ...(news.thumbnail_time !== undefined && { thumbnail_time: news.thumbnail_time }),
              });
              if (news.thumbnail_time === undefined && asset.thumbnail_time !== undefined) {
                yield* mux.request("DELETE", `${path(asset.id)}/thumbnail-time`);
              }
              return;
            }
            case "master-access":
              yield* mux.request("PUT", `${path(asset.id)}/master-access`, {
                master_access: news.master_access ?? "none",
              });
              return;
            case "static-renditions": {
              const desired = news.static_renditions ?? [];
              const existing = (asset.static_renditions?.files ?? []).filter((f) => f.id);
              for (const rendition of desired) {
                if (!existing.some((f) => f.resolution === rendition.resolution)) {
                  yield* mux.request("POST", `${path(asset.id)}/static-renditions`, rendition);
                }
              }
              for (const file of existing) {
                if (!desired.some((r) => r.resolution === file.resolution)) {
                  yield* mux
                    .request("DELETE", `${path(asset.id)}/static-renditions/${file.id}`)
                    .pipe(Effect.catchTag("NotFound", () => Effect.void));
                }
              }
              return;
            }
            case "playback-ids": {
              const desired = news.playback_policies ?? [];
              const current = asset.playback_ids ?? [];
              for (const policy of desired) {
                if (!current.some((p) => p.policy === policy)) {
                  yield* mux.request("POST", `${path(asset.id)}/playback-ids`, { policy });
                }
              }
              // Only remove policies this resource declared before, so playback
              // IDs added elsewhere (or via advanced_playback_policies) survive.
              const dropped = (olds?.playback_policies ?? []).filter((p) => !desired.includes(p));
              for (const id of current.filter((p) => dropped.includes(p.policy!))) {
                yield* mux
                  .request("DELETE", `${path(asset.id)}/playback-ids/${id.id}`)
                  .pipe(Effect.catchTag("NotFound", () => Effect.void));
              }
              return;
            }
            case "directives": {
              const before = directiveIds(olds);
              for (const id of directiveIds(news).filter((d) => !before.includes(d))) {
                yield* mux.request("POST", `/robots/v1/directives/${id}/runs`, { asset_id: asset.id });
              }
              return;
            }
          }
        });

      return {
        stables: ["id", "created_at"],
        list: () =>
          listAll<MuxAsset>(mux, "/video/v1/assets").pipe(Effect.map((assets) => assets.map(toAttrs))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          const needed = plan(olds ?? {}, news as AssetProps);
          if (needed === "replace") return { action: "replace" } as const;
          return needed.size > 0 ? ({ action: "update" } as const) : undefined;
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
          // Adopted assets have no prior props: apply every setting, but do not
          // start Directive runs (they cost money and may have already run).
          const needed =
            olds === undefined
              ? new Set(Object.values(APPLY).filter((how) => how !== "directives"))
              : plan(olds, news);
          if (needed === "replace") return yield* new AssetImmutableChange({ id: output.id });
          const current = yield* get(output.id);
          for (const how of needed) yield* apply(current, how, olds, news);
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
