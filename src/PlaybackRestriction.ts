import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { listAll, Mux } from "./Api.ts";
import type { Providers } from "./Providers.ts";

export interface ReferrerRestriction {
  /** `[]` denies every domain, `["*"]` allows any, otherwise up to 10 domains or wildcards. */
  allowed_domains: string[];
  allow_no_referrer?: boolean;
}

export interface UserAgentRestriction {
  allow_no_user_agent: boolean;
  allow_high_risk_user_agent: boolean;
}

export interface PlaybackRestrictionProps {
  referrer: ReferrerRestriction;
  user_agent?: UserAgentRestriction;
}

export interface PlaybackRestrictionAttributes {
  id: string;
  created_at: string;
  updated_at: string;
  referrer: ReferrerRestriction;
  user_agent: UserAgentRestriction;
}

export type PlaybackRestriction = Resource<
  "Mux.PlaybackRestriction",
  PlaybackRestrictionProps,
  PlaybackRestrictionAttributes,
  never,
  Providers
>;

/**
 * Limits which sites and user agents may play `signed` content. Reference
 * its `id` in the `playback_restriction_id` claim of a playback token.
 * @see https://www.mux.com/docs/guides/secure-video-playback#using-referer-http-header-for-validation
 *
 * **Example:** Only allow playback on your own domains
 * ```typescript
 * const restriction = yield* Mux.PlaybackRestriction("site-only", {
 *   referrer: { allowed_domains: ["example.com", "*.example.com"] },
 *   user_agent: { allow_no_user_agent: false, allow_high_risk_user_agent: false },
 * });
 * ```
 *
 * @resource
 */
export const PlaybackRestriction = Resource<PlaybackRestriction>("Mux.PlaybackRestriction");

export const PlaybackRestrictionProvider = () =>
  Provider.effect(
    PlaybackRestriction,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (id: string) => `/video/v1/playback-restrictions/${id}`;

      return {
        stables: ["id"],
        list: () =>
          listAll<PlaybackRestrictionAttributes>(mux, "/video/v1/playback-restrictions"),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          return deepEqual(olds, news) ? undefined : ({ action: "update" } as const);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          if (output === undefined) {
            return yield* mux.request<PlaybackRestrictionAttributes>(
              "POST",
              "/video/v1/playback-restrictions",
              news,
            );
          }
          let current = output;
          const referrer = { allow_no_referrer: false, ...news.referrer };
          // Mux omits allow_no_referrer from responses when it is false.
          if (!deepEqual({ allow_no_referrer: false, ...current.referrer }, referrer)) {
            current = yield* mux.request<PlaybackRestrictionAttributes>("PUT", `${path(output.id)}/referrer`, referrer);
          }
          if (news.user_agent && !deepEqual(current.user_agent, news.user_agent)) {
            current = yield* mux.request<PlaybackRestrictionAttributes>("PUT", `${path(output.id)}/user_agent`, news.user_agent);
          }
          return current;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* mux
            .request("DELETE", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* mux
            .request<PlaybackRestrictionAttributes>("GET", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        }),
      };
    }),
  );
