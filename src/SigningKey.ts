import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { listAll, Mux } from "./Api.ts";
import type { Providers } from "./Providers.ts";

export interface SigningKeyAttributes {
  id: string;
  created_at: string;
  /**
   * Base64-encoded RSA private key for signing playback, thumbnail and DRM
   * tokens. Mux returns it only at creation, so it lives in resource state.
   */
  private_key: Redacted.Redacted<string>;
}

export type SigningKey = Resource<"Mux.SigningKey", {}, SigningKeyAttributes, never, Providers>;

/**
 * A Mux URL signing key for `signed` and `drm` playback IDs.
 * @see https://www.mux.com/docs/guides/secure-video-playback
 *
 * **Example:** Hand the key to a Worker that mints playback tokens
 * ```typescript
 * const key = yield* Mux.SigningKey("playback");
 * yield* Cloudflare.Worker("api", {
 *   vars: { MUX_SIGNING_KEY_ID: key.id },
 *   secrets: { MUX_SIGNING_PRIVATE_KEY: key.private_key },
 * });
 * ```
 *
 * @resource
 */
export const SigningKey = Resource<SigningKey>("Mux.SigningKey");

interface MuxSigningKey {
  id: string;
  created_at: string;
  private_key?: string;
}

export const SigningKeyProvider = () =>
  Provider.effect(
    SigningKey,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (id: string) => `/system/v1/signing-keys/${id}`;

      return {
        stables: ["id", "private_key"],
        list: () =>
          listAll<MuxSigningKey>(mux, "/system/v1/signing-keys").pipe(
            Effect.map((keys) =>
              keys.map((key) => ({ id: key.id, created_at: key.created_at, private_key: Redacted.make("") })),
            ),
          ),
        reconcile: Effect.fn(function* ({ output }) {
          if (output !== undefined) return output;
          const key = yield* mux.request<MuxSigningKey>("POST", "/system/v1/signing-keys");
          return {
            id: key.id,
            created_at: key.created_at,
            private_key: Redacted.make(key.private_key ?? ""),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* mux
            .request("DELETE", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          // GET on a deleted key can keep answering 200 for minutes if it was
          // read before deletion; the list endpoint reflects deletes at once.
          const keys = yield* listAll<MuxSigningKey>(mux, "/system/v1/signing-keys");
          return keys.some((key) => key.id === output.id) ? output : undefined;
        }),
      };
    }),
  );
