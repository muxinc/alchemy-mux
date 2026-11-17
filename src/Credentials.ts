import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { MUX_AUTH_PROVIDER_NAME, type MuxResolvedCredentials } from "./AuthProvider.ts";

export const DEFAULT_API_BASE_URL = "https://api.mux.com";

export interface MuxConfig {
  readonly tokenId: Redacted.Redacted<string>;
  readonly tokenSecret: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

/** Resolves the current Mux access token on each use. */
export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<MuxConfig, { readonly _tag: string; readonly message: string }>
>()("MuxCredentials") {}

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<MuxResolvedCredentials>()(MUX_AUTH_PROVIDER_NAME, (creds) => ({
      tokenId: creds.tokenId,
      tokenSecret: creds.tokenSecret,
      apiBaseUrl: creds.apiBaseUrl,
    })),
  );
