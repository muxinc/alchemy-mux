import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { listAll, Mux } from "./Api.ts";
import type { components } from "./generated/mux-api.ts";
import type { Providers } from "./Providers.ts";

export interface AnnotationProps {
  /** Text shown on Mux Data charts, e.g. `Deployed ${gitSha}`. */
  note: string;
  /** Unix seconds. Defaults to the moment the annotation is created. */
  date?: number;
  /** Scope the marker to one sub-property (Mux Data environment sub-property). */
  sub_property_id?: string;
}

export type AnnotationAttributes = components["schemas"]["Annotation"];

export type Annotation = Resource<
  "Mux.Annotation",
  AnnotationProps,
  AnnotationAttributes,
  never,
  Providers
>;

/**
 * A marker on Mux Data charts, so a change in rebuffering or startup time can
 * be lined up with what shipped. An annotation marks a moment: changing any
 * prop creates a new one. Add `RemovalPolicy.retain()` to keep each old
 * marker as release history. `alchemy deploy --detect-drift` puts back a
 * note edited in the dashboard.
 * @see https://www.mux.com/docs/guides/annotations
 *
 * **Example:** Mark every release on Mux Data
 * ```typescript
 * yield* Mux.Annotation("release", { note: `Deployed ${process.env.GIT_SHA}` }).pipe(
 *   RemovalPolicy.retain(),
 * );
 * ```
 *
 * @resource
 */
export const Annotation = Resource<Annotation>("Mux.Annotation");

export const AnnotationProvider = () =>
  Provider.effect(
    Annotation,
    Effect.gen(function* () {
      const mux = yield* Mux;
      const path = (id: string) => `/data/v1/annotations/${id}`;

      return {
        stables: ["id"],
        list: () => listAll<AnnotationAttributes>(mux, "/data/v1/annotations"),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          if (!isResolved(news)) return { action: "replace" } as const;
          return deepEqual(olds, news) ? undefined : ({ action: "replace" } as const);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          if (output !== undefined) {
            // Only drift repair reaches here (any prop change replaces), with
            // `output` as Mux reports it: put back a note edited in the dashboard.
            const date = Math.floor(Date.parse(output.date) / 1000);
            const drifted =
              output.note !== news.note ||
              (output.sub_property_id ?? undefined) !== news.sub_property_id ||
              (news.date !== undefined && date !== news.date);
            if (!drifted) return output;
            return yield* mux.request<AnnotationAttributes>("PATCH", path(output.id), {
              note: news.note,
              date: news.date ?? date,
              ...(news.sub_property_id !== undefined && { sub_property_id: news.sub_property_id }),
            });
          }
          return yield* mux.request<AnnotationAttributes>("POST", "/data/v1/annotations", {
            ...news,
            date: news.date ?? Math.floor(Date.now() / 1000),
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* mux
            .request("DELETE", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* mux
            .request<AnnotationAttributes>("GET", path(output.id))
            .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        }),
      };
    }),
  );
