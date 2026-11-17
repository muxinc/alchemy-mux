import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Mux from "../../src/index.ts";

const run = process.env.MUX_TEST_RUN!;
/** One day before the run started; stable across every phase of a run. */
export const pinnedDate = (run: string) => Math.floor(parseInt(run, 36) / 1000) - 86_400;

const version = process.env.MUX_TEST_PHASE === "create" ? "v1" : "v2";

export default Alchemy.Stack(
  "MuxVerifyAnnotation",
  { providers: Mux.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const marker = yield* Mux.Annotation("marker", { note: `verify ${run} ${version}` });
    const pinned = yield* Mux.Annotation("pinned", { note: `verify ${run} pinned`, date: pinnedDate(run) });
    const kept = yield* Mux.Annotation("kept", { note: `verify ${run} kept ${version}` }).pipe(
      RemovalPolicy.retain(),
    );
    return { marker: marker.id, pinned: pinned.id, kept: kept.id };
  }),
);
