import { createHmac } from "node:crypto";
import MuxSdk from "@mux/ts";
import type { BaseRuntimeContext } from "alchemy/RuntimeContext";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { PlaybackSigner, PlaybackSignerLive } from "../../src/PlaybackSigner.ts";
import type { SigningKey } from "../../src/SigningKey.ts";
import type { Webhook } from "../../src/Webhook.ts";
import { WebhookVerifier, WebhookVerifierLive } from "../../src/WebhookVerifier.ts";
import { check, mux } from "../lib.ts";
import type { Scenario } from "../scenario.ts";

/** An in-memory host: `set` at deploy time, `get` at runtime, like a Worker's bindings. */
function fakeHost() {
  const stored = new Map<string, unknown>();
  const host: BaseRuntimeContext = {
    Type: "Test.Host",
    id: "test-host",
    env: {},
    get: <T>(key: string) => Effect.succeed(stored.get(key) as T | undefined),
    set: (key: string, value: unknown) => Effect.sync(() => (stored.set(key, value), key)),
  };
  return { stored, host };
}

/** Runs `body` at deploy time, then at runtime, against the same host. */
async function deployThenRun<A>(
  host: BaseRuntimeContext,
  bind: Effect.Effect<A, never, any>,
  use: (client: A) => Effect.Effect<any, any, any>,
) {
  const provide = <X, E>(effect: Effect.Effect<X, E, any>) =>
    effect.pipe(
      Effect.provide(PlaybackSignerLive),
      Effect.provide(WebhookVerifierLive),
      Effect.provideService(RuntimeContext, host),
    ) as Effect.Effect<X, E, never>;
  globalThis.__ALCHEMY_RUNTIME__ = false as never;
  await Effect.runPromise(provide(bind));
  globalThis.__ALCHEMY_RUNTIME__ = true as never;
  try {
    const client = await Effect.runPromise(provide(bind));
    return await Effect.runPromiseExit(provide(use(client)));
  } finally {
    globalThis.__ALCHEMY_RUNTIME__ = undefined as never;
  }
}

const status = async (url: string) => (await fetch(url)).status;

/** New signing keys can take a moment to reach the edge; wait for a 200. */
async function eventually200(url: string) {
  for (let i = 0; i < 30; i++) {
    if ((await status(url)) === 200) return true;
    await Bun.sleep(2000);
  }
  return false;
}

const muxSignature = (secret: string, body: string, t: number) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

export const bindings: Scenario = {
  name: "bindings",
  stack: "MuxVerifyBindings",
  stackFile: "test/stacks/bindings.run.ts",
  resources: {
    key: (a) => `/system/v1/signing-keys/${a.id}`,
    asset: (a) => `/video/v1/assets/${a.id}`,
    hook: (a) => `/system/v1/webhooks/${a.id}`,
  },
  isGone: {
    key: async (a) => {
      const keys = (await mux("GET", "/system/v1/signing-keys?limit=100")).data;
      return !keys.some((k: { id: string }) => k.id === a.id);
    },
  },
  phases: [
    {
      name: "create",
      plan: { key: "create", asset: "create", hook: "create" },
      verify: async ({ state }) => {
        const key = {
          FQN: "MuxVerifyBindings/key",
          id: state.key!.id,
          private_key: Redacted.make(state.key!.private_key),
        } as unknown as SigningKey;
        const playbackId = state.asset!.playback_ids.find((p: any) => p.policy === "signed").id;

        const signer = fakeHost();
        const exit = await deployThenRun(signer.host, PlaybackSigner(key), (client) =>
          Effect.all({
            video: client.sign(playbackId),
            thumbnail: client.sign(playbackId, { type: "thumbnail", claims: { time: 1 } }),
            expired: client.sign(playbackId, { expiresIn: -120 }),
          }),
        );
        check(Exit.isSuccess(exit), `PlaybackSigner failed: ${JSON.stringify(Exit.isFailure(exit) && exit.cause)}`);
        const values = [...signer.stored.values()];
        check(values.some((v) => Redacted.isRedacted(v)), "private key was not stored on the host as a secret");
        check(!values.some((v) => v === state.key!.private_key), "private key was stored on the host in plain text");

        const { video, thumbnail, expired } = exit.value;
        const hls = `https://stream.mux.com/${playbackId}.m3u8`;
        check((await status(hls)) === 403, "signed playback id played without a token");
        check(await eventually200(`${hls}?token=${video}`), "signed video token rejected by stream.mux.com");
        check(
          (await status(`https://image.mux.com/${playbackId}/thumbnail.jpg?token=${thumbnail}`)) === 200,
          "signed thumbnail token rejected by image.mux.com",
        );
        check((await status(`${hls}?token=${thumbnail}`)) === 403, "thumbnail token was accepted for video");
        check((await status(`${hls}?token=${expired}`)) === 403, "expired token was accepted");
        const tampered = video.slice(0, -4) + (video.endsWith("AAAA") ? "BBBB" : "AAAA");
        check((await status(`${hls}?token=${tampered}`)) === 403, "tampered token was accepted");

        const secret = state.hook!.signing_secret as string;
        const hook = {
          FQN: "MuxVerifyBindings/hook",
          signing_secret: Redacted.make(secret),
        } as unknown as Webhook;
        const body = JSON.stringify({ type: "video.asset.ready", data: { id: state.asset!.id } });
        const now = Math.floor(Date.now() / 1000);
        const header = muxSignature(secret, body, now);
        await new MuxSdk({ tokenId: "x", tokenSecret: "y" }).webhooks.verifySignature(
          body,
          { "mux-signature": header },
          secret,
        );

        const verifier = fakeHost();
        const cases = {
          valid: [body, header],
          tamperedBody: [body.replace("ready", "errored"), header],
          wrongSecret: [body, muxSignature("not-the-secret", body, now)],
          stale: [body, muxSignature(secret, body, now - 600)],
          missing: [body, undefined],
        } as const;
        const results: Record<string, boolean> = {};
        for (const [name, [rawBody, sig]] of Object.entries(cases)) {
          const result = await deployThenRun(verifier.host, WebhookVerifier(hook), (client) =>
            client.verify(rawBody, sig),
          );
          results[name] = Exit.isSuccess(result);
        }
        check(
          [...verifier.stored.values()].every((v) => Redacted.isRedacted(v)),
          "webhook signing secret was not stored on the host as a secret",
        );
        check(results.valid, "verifier rejected a signature that Mux's SDK accepts");
        for (const name of ["tamperedBody", "wrongSecret", "stale", "missing"]) {
          check(!results[name], `verifier accepted a ${name} signature`);
        }
      },
    },
  ],
};
