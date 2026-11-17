import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Mux } from "./Api.ts";
import type { components } from "./generated/mux-api.ts";
import type { Providers } from "./Providers.ts";

type MuxSimulcastTarget = components["schemas"]["SimulcastTarget"];

export interface SimulcastTargetProps {
  /** The Mux live stream to restream. */
  live_stream_id: string;
  /** RTMP(S) ingest URL of the destination, e.g. `rtmps://a.rtmp.youtube.com/live2`. */
  url: string;
  /** The destination's stream key. Pass a Redacted value from a secret store. */
  stream_key?: string | Redacted.Redacted<string>;
  passthrough?: string;
}

export type SimulcastTargetAttributes = Omit<MuxSimulcastTarget, "stream_key"> & {
  live_stream_id: string;
};

export type SimulcastTarget = Resource<
  "Mux.SimulcastTarget",
  SimulcastTargetProps,
  SimulcastTargetAttributes,
  never,
  Providers
>;

/**
 * Restreams a Mux live stream to another RTMP destination (YouTube, Twitch,
 * LinkedIn). Mux has no update endpoint for targets, so any change creates a
 * new target. Mux only accepts target changes while the stream is idle, and
 * rejects targets on `test: true` streams.
 * @see https://www.mux.com/docs/guides/stream-live-to-3rd-party-platforms
 *
 * **Example:** Restream to YouTube
 * ```typescript
 * yield* Mux.SimulcastTarget("youtube", {
 *   live_stream_id: stream.id,
 *   url: "rtmps://a.rtmp.youtube.com/live2",
 *   stream_key: Redacted.make(process.env.YOUTUBE_STREAM_KEY!),
 * });
 * ```
 *
 * @resource
 */
export const SimulcastTarget = Resource<SimulcastTarget>("Mux.SimulcastTarget");

/** Raised if the engine asks to update a target in place, which Mux cannot do. */
export class SimulcastTargetImmutable extends Data.TaggedError("SimulcastTargetImmutable")<{
  readonly id: string;
}> {
  override get message() {
    return `Simulcast target ${this.id} cannot be updated in place; it must be replaced.`;
  }
}

const reveal = (key: SimulcastTargetProps["stream_key"]) =>
  key === undefined ? undefined : Redacted.isRedacted(key) ? Redacted.value(key) : key;

const toAttrs = (target: MuxSimulcastTarget, liveStreamId: string): SimulcastTargetAttributes => {
  const { stream_key: _secret, ...rest } = target;
  return { ...rest, live_stream_id: liveStreamId };
};

export const SimulcastTargetProvider = () =>
  Provider.effect(
    SimulcastTarget,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (streamId: string, id = "") =>
        `/video/v1/live-streams/${streamId}/simulcast-targets${id ? `/${id}` : ""}`;

      const comparable = (props: SimulcastTargetProps | undefined) =>
        props && { ...props, stream_key: reveal(props.stream_key) };

      return {
        stables: ["id", "live_stream_id"],
        // Targets live under a stream; enumeration happens through LiveStream.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          // Unresolved props mean an upstream value is changing (typically the
          // stream being replaced). Targets cannot be updated, so replace.
          if (!isResolved(news)) return { action: "replace" } as const;
          return deepEqual(comparable(olds), comparable(news))
            ? undefined
            : ({ action: "replace" } as const);
        }),
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          if (output !== undefined) {
            if (output.live_stream_id === news.live_stream_id && deepEqual(comparable(olds), comparable(news))) {
              return output;
            }
            return yield* new SimulcastTargetImmutable({ id: output.id });
          }
          const created = yield* mux.request<MuxSimulcastTarget>("POST", path(news.live_stream_id), {
            url: news.url,
            stream_key: reveal(news.stream_key),
            passthrough: news.passthrough,
          });
          return toAttrs(created, news.live_stream_id);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* mux
            .request("DELETE", path(output.live_stream_id, output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* mux
            .request<MuxSimulcastTarget>("GET", path(output.live_stream_id, output.id))
            .pipe(
              Effect.map((target) => toAttrs(target, output.live_stream_id)),
              Effect.catchTag("NotFound", () => Effect.undefined),
            );
        }),
      };
    }),
  );
