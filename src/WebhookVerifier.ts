import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { bindEnvironment, bindingEnvKey, bindingSecret } from "./BindingEnv.ts";
import type { Webhook } from "./Webhook.ts";

export class WebhookSignatureInvalid extends Data.TaggedError("WebhookSignatureInvalid")<{
  readonly reason: string;
}> {
  override get message() {
    return `Mux webhook signature rejected: ${this.reason}`;
  }
}

export interface VerifyOptions {
  /** Reject signatures older than this many seconds. Defaults to 300. */
  toleranceSeconds?: number;
  /** Clock override, in Unix seconds. */
  now?: number;
}

export interface WebhookVerifierClient {
  /**
   * Checks the `mux-signature` header against the raw request body. Pass the
   * body exactly as received; re-serialized JSON will not verify.
   */
  verify: (
    rawBody: string,
    signatureHeader: string | null | undefined,
    options?: VerifyOptions,
  ) => Effect.Effect<void, WebhookSignatureInvalid, RuntimeContext>;
}

/**
 * Verifies that webhook requests came from Mux, using the {@link Webhook}'s
 * signing secret carried to the host as a secret.
 * @see https://www.mux.com/docs/core/verify-webhook-signatures
 *
 * **Example:**
 * ```typescript
 * const verifier = yield* Mux.WebhookVerifier(hook);
 * // in the request handler:
 * const body = yield* request.text;
 * yield* verifier.verify(body, request.headers["mux-signature"]);
 * ```
 *
 * @binding
 */
export interface WebhookVerifier extends Binding.Service<
  WebhookVerifier,
  "Mux.WebhookVerifier",
  (webhook: Webhook) => Effect.Effect<WebhookVerifierClient>
> {}
export const WebhookVerifier = Binding.Service<WebhookVerifier>("Mux.WebhookVerifier");

const hmacHex = async (secret: string, payload: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
};

const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Verifies a Mux webhook signature. Exported for use outside a binding. */
export const verifyWebhookSignature = async (
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) }: VerifyOptions = {},
): Promise<string | undefined> => {
  if (!header) return "missing mux-signature header";
  const parts = header.split(",").map((part) => part.split("="));
  const timestamp = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isInteger(timestamp)) return "no timestamp in mux-signature header";
  if (signatures.length === 0) return "no v1 signature in mux-signature header";
  if (Math.abs(now - timestamp) > toleranceSeconds) return "timestamp outside tolerance";
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((sig) => constantTimeEqual(sig, expected)) ? undefined : "signature mismatch";
};

export const WebhookVerifierLive = Layer.succeed(
  WebhookVerifier,
  Effect.fn(function* (webhook: Webhook) {
    const secretKey = bindingEnvKey(webhook.FQN, "WEBHOOK_SIGNING_SECRET");
    yield* bindEnvironment(`Mux.WebhookVerifier:${webhook.FQN}`, {
      [secretKey]: webhook.signing_secret,
    });
    return {
      verify: (rawBody, header, options) =>
        Effect.gen(function* () {
          const secret = Redacted.value(yield* bindingSecret(secretKey));
          const reason = yield* Effect.promise(() =>
            verifyWebhookSignature(secret, rawBody, header, options),
          );
          if (reason) return yield* new WebhookSignatureInvalid({ reason });
        }),
    } satisfies WebhookVerifierClient;
  }),
);
