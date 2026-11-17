import type * as Output from "alchemy/Output";
import { CurrentRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** Host env key for one field of a bound Mux resource. Hex keeps it host-safe and collision-free. */
export const bindingEnvKey = (fqn: string, field: string) =>
  `MUX_BINDING_${Array.from(fqn, (c) => c.codePointAt(0)!.toString(16).toUpperCase()).join("_")}_${field}`;

type EnvValue = string | Redacted.Redacted<string>;

/**
 * At deploy time, stores values on the host being built (Worker secret or
 * plain-text binding, Lambda env var). `Redacted` values stay secret. At
 * runtime this is a no-op; read values back with {@link bindingString} and
 * {@link bindingSecret}.
 */
export const bindEnvironment = Effect.fn(function* (
  owner: string,
  env: Record<string, Output.Output<EnvValue> | EnvValue>,
) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const runtime = yield* CurrentRuntimeContext;
  if (!runtime) {
    return yield* Effect.die(
      new Error(`${owner}: Mux bindings must be bound while initializing a Function or Worker`),
    );
  }
  for (const [key, value] of Object.entries(env)) {
    const stored = yield* runtime.set(key, value as Output.Output);
    if (stored !== key) {
      return yield* Effect.die(new Error(`${owner}: host ${runtime.Type} stored ${key} as ${stored}`));
    }
  }
});

const bindingValue = (key: string): Effect.Effect<EnvValue, never, RuntimeContext> =>
  RuntimeContext.pipe(
    Effect.flatMap((runtime) => runtime.get<EnvValue>(key)),
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.die(new Error(`Mux binding ${key} is not set on this host`))
        : Effect.succeed(value),
    ),
  );

export const bindingString = (key: string) =>
  bindingValue(key).pipe(Effect.map((v) => (Redacted.isRedacted(v) ? Redacted.value(v) : v)));

export const bindingSecret = (key: string) =>
  bindingValue(key).pipe(Effect.map((v) => (Redacted.isRedacted(v) ? v : Redacted.make(v))));
