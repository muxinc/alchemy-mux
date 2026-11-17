import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { listAll, Mux } from "./Api.ts";
import type { components } from "./generated/mux-api.ts";
import type { Providers } from "./Providers.ts";

type Schemas = components["schemas"];

export type DirectiveProps = Omit<Schemas["DirectiveConfig"], "subject"> & {
  /** Only `video.asset` exists today. Defaults to it. */
  subject?: Schemas["DirectiveSubject"];
};

export type DirectiveAttributes = Omit<Schemas["Directive"], "_links">;

export type Directive = Resource<
  "Mux.Robots.Directive",
  DirectiveProps,
  DirectiveAttributes,
  never,
  Providers
>;

/**
 * A Mux Robots Directive: several AI workflows (captions, translation,
 * chapters, summaries, moderation) run in dependency order on an asset.
 * Attach it with `Mux.Asset({ directives: [{ id: directive.id }] })` and it
 * runs automatically when the asset is ready.
 *
 * Mux locks a Directive's configuration at creation, so any change creates a
 * new Directive. Assets created earlier keep the runs they already had.
 * @see https://www.mux.com/docs/guides/robots-directives
 *
 * **Example:** English captions, then a Spanish translation
 * ```typescript
 * const captions = yield* Mux.Robots.Directive("captions", {
 *   name: "Captions + Spanish",
 *   resources: [{
 *     reference_id: "captions_en", type: "video.asset.track", kind: "subtitles",
 *     language_code: "en", source: { via: "workflow", binding: "premium_captions" },
 *   }],
 *   bindings: [
 *     { reference_id: "premium_captions", workflow: "generate-premium-captions", parameters: { language_code: "en" } },
 *     { reference_id: "translate_es", workflow: "translate-captions", inputs: ["captions_en"], parameters: { output_language_code: "es" } },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Directive = Resource<Directive>("Mux.Robots.Directive");

const toAttrs = ({ _links, ...directive }: Schemas["Directive"]): DirectiveAttributes => directive;

export const DirectiveProvider = () =>
  Provider.effect(
    Directive,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (id: string) => `/robots/v1/directives/${id}`;

      return {
        stables: ["id", "created_at"],
        list: () =>
          listAll<Schemas["Directive"]>(mux, "/robots/v1/directives").pipe(
            Effect.map((directives) => directives.map(toAttrs)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          if (!isResolved(news)) return { action: "replace" } as const;
          return deepEqual(olds, news) ? undefined : ({ action: "replace" } as const);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          if (output !== undefined) return output;
          const created = yield* mux.request<Schemas["Directive"]>("POST", "/robots/v1/directives", {
            ...news,
            subject: news.subject ?? { type: "video.asset" },
          });
          return toAttrs(created);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* mux
            .request("DELETE", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* mux.request<Schemas["Directive"]>("GET", path(output.id)).pipe(
            Effect.map(toAttrs),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),
      };
    }),
  );
