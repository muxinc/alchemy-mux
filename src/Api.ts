import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Credentials } from "./Credentials.ts";

export class NotFound extends Data.TaggedError("NotFound")<{ readonly path: string }> {
  override get message() {
    return `Mux resource not found: ${this.path}`;
  }
}

export class MuxApiError extends Data.TaggedError("MuxApiError")<{
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: string;
}> {
  override get message() {
    return `Mux ${this.method} ${this.path} failed with ${this.status}: ${this.body}`;
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface MuxApi {
  /** Calls the Mux REST API and unwraps its `{ data }` envelope. */
  readonly request: <A>(
    method: Method,
    path: string,
    body?: unknown,
  ) => Effect.Effect<A, NotFound | MuxApiError | { readonly _tag: string; readonly message: string }>;
}

export class Mux extends Context.Service<Mux, MuxApi>()("MuxApi") {}

const PAGE_SIZE = 100;

export const MAX_RETRIES = 6;

/** Honors `Retry-After` (seconds), else exponential backoff with jitter, capped at 20s. */
export const retryDelay = (attempt: number, retryAfter: string | undefined) => {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return Math.min(500 * 2 ** attempt, 20_000) * (0.75 + Math.random() * 0.5);
};

/** Reads every page of a Mux list endpoint. */
export const listAll = <A>(mux: MuxApi, path: string) =>
  Effect.gen(function* () {
    const items: A[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = yield* mux.request<A[]>("GET", `${path}${sep}limit=${PAGE_SIZE}&page=${page}`);
      items.push(...(batch ?? []));
      if (!batch || batch.length < PAGE_SIZE) return items;
    }
  });

export const MuxLive = Layer.effect(
  Mux,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const http = yield* HttpClient.HttpClient;

    const request: MuxApi["request"] = (method, path, body) =>
      Effect.gen(function* () {
        const { tokenId, tokenSecret, apiBaseUrl } = yield* credentials;
        let req = HttpClientRequest.make(method)(`${apiBaseUrl}${path}`).pipe(
          HttpClientRequest.basicAuth(Redacted.value(tokenId), Redacted.value(tokenSecret)),
          HttpClientRequest.setHeader("accept", "application/json"),
        );
        if (body !== undefined) req = HttpClientRequest.bodyJsonUnsafe(req, body);
        for (let attempt = 0; ; attempt++) {
          const res = yield* http.execute(req).pipe(
            Effect.catch((cause) =>
              Effect.fail(new MuxApiError({ method, path, status: 0, body: String(cause) })),
            ),
          );
          if (res.status === 404) return yield* new NotFound({ path });
          const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          if (res.status < 400) return (text ? JSON.parse(text).data : undefined) as any;
          // A 429 was rejected before processing, so any method may retry. A 5xx
          // may have been processed, so only methods safe to repeat retry.
          const retryable = res.status === 429 || (res.status >= 500 && method !== "POST");
          if (!retryable || attempt >= MAX_RETRIES) {
            return yield* new MuxApiError({ method, path, status: res.status, body: text });
          }
          yield* Effect.sleep(Duration.millis(retryDelay(attempt, res.headers["retry-after"])));
        }
      });

    return { request };
  }),
);

/** Mux returns playback IDs in no stable order; sort so attributes are deterministic. */
export const sortPlaybackIds = <P extends { id?: string; policy?: string }>(ids: P[] | undefined): P[] =>
  [...(ids ?? [])].sort((a, b) => `${a.policy}:${a.id}`.localeCompare(`${b.policy}:${b.id}`));

/**
 * First playback ID per policy. Alchemy Outputs cannot be indexed, so these
 * give stacks a direct handle: `asset.public_playback_id`.
 */
export const playbackIdsByPolicy = (ids: { id?: string; policy?: string }[]) => ({
  public_playback_id: ids.find((p) => p.policy === "public")?.id,
  signed_playback_id: ids.find((p) => p.policy === "signed")?.id,
  drm_playback_id: ids.find((p) => p.policy === "drm")?.id,
});

export interface PlaybackIdsByPolicy {
  /** First `public` playback ID: `https://stream.mux.com/{id}.m3u8`. */
  public_playback_id?: string;
  /** First `signed` playback ID; play it with a token from `PlaybackSigner`. */
  signed_playback_id?: string;
  /** First `drm` playback ID. */
  drm_playback_id?: string;
}
