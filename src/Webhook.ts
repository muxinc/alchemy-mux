import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { listAll, Mux, MuxApiError } from "./Api.ts";
import type { components } from "./generated/mux-api.ts";
import type { Providers } from "./Providers.ts";

type MuxWebhook = components["schemas"]["Webhook"];

export interface WebhookProps {
  /** HTTPS URL Mux posts events to. Must be unique within the environment. */
  address: string;
  /** Set `false` to pause delivery without deleting the webhook. Defaults to `true`. */
  enabled?: boolean;
}

export interface WebhookAttributes {
  id: string;
  address: string;
  enabled: boolean;
  created_at: string;
  /**
   * Verifies the `mux-signature` header. Mux returns it only at creation, so
   * it lives in resource state. A webhook found through `lookup` has none.
   */
  signing_secret: Redacted.Redacted<string>;
}

export interface WebhookLookup {
  address: string;
}

export type Webhook = Resource<
  "Mux.Webhook",
  WebhookProps,
  WebhookAttributes,
  never,
  Providers,
  WebhookLookup
>;

/**
 * Where Mux sends events (asset ready, live stream active, Robots job done)
 * for the access token's environment. Requires a token with System write.
 * @see https://www.mux.com/docs/core/manage-webhooks
 *
 * **Example:** Point Mux at a Worker and hand it the signing secret
 * ```typescript
 * const api = yield* Cloudflare.Worker("api", { ... });
 * const hook = yield* Mux.Webhook("events", { address: Output.interpolate`${api.url}/mux` });
 * // hook.signing_secret -> a Worker secret, used to verify `mux-signature`
 * ```
 *
 * @resource
 */
export const Webhook = Resource<Webhook>("Mux.Webhook");

/** Mux allows one webhook per address per environment. */
export class WebhookAddressInUse extends Data.TaggedError("WebhookAddressInUse")<{
  readonly address: string;
}> {
  override get message() {
    return (
      `A Mux webhook for ${this.address} already exists in this environment. ` +
      "Delete it in the dashboard, or reference it with Mux.Webhook.lookup({ address })."
    );
  }
}

const toAttrs = (hook: MuxWebhook, secret: Redacted.Redacted<string>): WebhookAttributes => ({
  id: hook.id,
  address: hook.address,
  enabled: hook.enabled,
  created_at: hook.created_at,
  signing_secret: secret,
});

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (id: string) => `/system/v1/webhooks/${id}`;
      const noSecret = Redacted.make("");

      const addressInUse =
        (address: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.mapError((error) =>
              error instanceof MuxApiError && error.status === 400
                ? new WebhookAddressInUse({ address })
                : error,
            ),
          );

      return {
        stables: ["id", "signing_secret"],
        list: () =>
          listAll<MuxWebhook>(mux, "/system/v1/webhooks").pipe(
            Effect.map((hooks) => hooks.map((hook) => toAttrs(hook, noSecret))),
          ),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const enabled = news.enabled ?? true;
          return news.address !== output.address || enabled !== output.enabled
            ? ({ action: "update" } as const)
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const enabled = news.enabled ?? true;
          if (output === undefined) {
            const created = yield* mux
              .request<MuxWebhook>("POST", "/system/v1/webhooks", { address: news.address })
              .pipe(addressInUse(news.address));
            const secret = Redacted.make(created.signing_secret ?? "");
            if (enabled) return toAttrs(created, secret);
            const paused = yield* mux.request<MuxWebhook>("PATCH", path(created.id), { enabled });
            return toAttrs(paused, secret);
          }
          if (news.address === output.address && enabled === output.enabled) return output;
          const updated = yield* mux
            .request<MuxWebhook>("PATCH", path(output.id), { address: news.address, enabled })
            .pipe(addressInUse(news.address));
          return toAttrs(updated, output.signing_secret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* mux
            .request("DELETE", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* mux.request<MuxWebhook>("GET", path(output.id)).pipe(
            Effect.map((hook) => toAttrs(hook, output.signing_secret)),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),
        lookup: Effect.fn(function* ({ address }) {
          const hooks = yield* listAll<MuxWebhook>(mux, "/system/v1/webhooks");
          const hook = hooks.find((candidate) => candidate.address === address);
          return hook === undefined ? undefined : toAttrs(hook, noSecret);
        }),
      };
    }),
  );
