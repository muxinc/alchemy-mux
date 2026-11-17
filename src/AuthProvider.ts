import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const MUX_AUTH_PROVIDER_NAME = "Mux";

const DEFAULT_API_BASE_URL = "https://api.mux.com";

export interface MuxResolvedCredentials {
  tokenId: Redacted.Redacted<string>;
  tokenSecret: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: "stored" | "env" };
}

const readEnvironment = Effect.gen(function* () {
  const tokenId = yield* getEnvRedacted("MUX_TOKEN_ID");
  const tokenSecret = yield* getEnvRedacted("MUX_TOKEN_SECRET");
  if (!tokenId || !tokenSecret) {
    return yield* AuthError.make({
      message: "Mux credentials not found. Set MUX_TOKEN_ID and MUX_TOKEN_SECRET.",
    });
  }
  return {
    tokenId,
    tokenSecret,
    apiBaseUrl: (yield* getEnv("MUX_API_BASE_URL")) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const },
  };
});

const muxAuth = makeStoredAuthProvider<MuxResolvedCredentials>({
  provider: MUX_AUTH_PROVIDER_NAME,
  fields: [
    { name: "tokenId", label: "Mux Access Token ID" },
    { name: "tokenSecret", label: "Mux Access Token Secret", secret: true },
  ],
  toResolved: (values, source) => ({
    tokenId: Redacted.make(storedValueText(values.tokenId) ?? ""),
    tokenSecret: storedSecret(values.tokenSecret) ?? Redacted.make(""),
    apiBaseUrl: DEFAULT_API_BASE_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    { name: "MUX_TOKEN_ID", required: true, description: "Access token ID." },
    { name: "MUX_TOKEN_SECRET", required: true, secret: true, description: "Access token secret." },
    { name: "MUX_API_BASE_URL", required: false, description: "Override the API host." },
  ],
});

/** Registers the Mux AuthProvider so `alchemy profile edit` can configure it. */
export const MuxAuth = muxAuth.layer;
