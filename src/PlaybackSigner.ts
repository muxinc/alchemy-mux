import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { bindEnvironment, bindingEnvKey, bindingSecret, bindingString } from "./BindingEnv.ts";
import type { SigningKey } from "./SigningKey.ts";

export type TokenType = "video" | "thumbnail" | "gif" | "storyboard" | "drm_license";

const AUDIENCE: Record<TokenType, string> = {
  video: "v",
  thumbnail: "t",
  gif: "g",
  storyboard: "s",
  drm_license: "d",
};

export interface SignOptions {
  /** What the token unlocks. Defaults to `"video"`. */
  type?: TokenType;
  /** Lifetime in seconds. Defaults to 3600. */
  expiresIn?: number;
  /** A {@link PlaybackRestriction} id to enforce. */
  playbackRestrictionId?: string;
  /** Extra claims, e.g. thumbnail `time` or `width`, or `custom` data for Mux Data. */
  claims?: Record<string, unknown>;
}

export interface PlaybackSignerClient {
  /** Returns a JWT for `?token=` on stream.mux.com or image.mux.com. */
  sign: (playbackId: string, options?: SignOptions) => Effect.Effect<string, never, RuntimeContext>;
}

/**
 * Mints signed playback, thumbnail, GIF, storyboard and DRM license tokens
 * from a Function or Worker, with the {@link SigningKey}'s private key
 * carried to the host as a secret. Uses WebCrypto, so it runs on Workers,
 * Lambda, Node and Bun.
 * @see https://www.mux.com/docs/guides/secure-video-playback
 *
 * **Example:**
 * ```typescript
 * const signer = yield* Mux.PlaybackSigner(key);
 * // in a request handler:
 * const token = yield* signer.sign(playbackId, { expiresIn: 600 });
 * // https://stream.mux.com/${playbackId}.m3u8?token=${token}
 * ```
 *
 * @binding
 */
export interface PlaybackSigner extends Binding.Service<
  PlaybackSigner,
  "Mux.PlaybackSigner",
  (key: SigningKey) => Effect.Effect<PlaybackSignerClient>
> {}
export const PlaybackSigner = Binding.Service<PlaybackSigner>("Mux.PlaybackSigner");

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

const derLength = (length: number) => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
};

const der = (tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array([tag, ...derLength(body.length), ...body]);

/** RSA AlgorithmIdentifier (rsaEncryption OID + NULL), for wrapping PKCS#1 in PKCS#8. */
const RSA_ALGORITHM = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Mux returns base64 of a PEM. WebCrypto needs PKCS#8 DER, so PKCS#1 keys are wrapped. */
export const privateKeyToPkcs8 = (base64Pem: string): Uint8Array<ArrayBuffer> => {
  const pem = atob(base64Pem);
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const keyDer = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return keyDer;
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  return der(0x30, new Uint8Array([...version, ...RSA_ALGORITHM, ...der(0x04, keyDer)]));
};

/** Signs a Mux playback token. Exported for use outside a binding. */
export const signPlaybackToken = async (
  key: { id: string; privateKey: string },
  playbackId: string,
  options: SignOptions = {},
) => {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: key.id });
  const payload = encodeJson({
    sub: playbackId,
    aud: AUDIENCE[options.type ?? "video"],
    exp: Math.floor(Date.now() / 1000) + (options.expiresIn ?? 3600),
    kid: key.id,
    ...(options.playbackRestrictionId && { playback_restriction_id: options.playbackRestrictionId }),
    ...options.claims,
  });
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyToPkcs8(key.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
};

export const PlaybackSignerLive = Layer.succeed(
  PlaybackSigner,
  Effect.fn(function* (key: SigningKey) {
    const idKey = bindingEnvKey(key.FQN, "SIGNING_KEY_ID");
    const secretKey = bindingEnvKey(key.FQN, "SIGNING_PRIVATE_KEY");
    yield* bindEnvironment(`Mux.PlaybackSigner:${key.FQN}`, {
      [idKey]: key.id,
      [secretKey]: key.private_key,
    });
    return {
      sign: (playbackId: string, options?: SignOptions) =>
        Effect.gen(function* () {
          const id = yield* bindingString(idKey);
          const privateKey = Redacted.value(yield* bindingSecret(secretKey));
          return yield* Effect.promise(() =>
            signPlaybackToken({ id, privateKey }, playbackId, options),
          );
        }),
    } satisfies PlaybackSignerClient;
  }),
);
