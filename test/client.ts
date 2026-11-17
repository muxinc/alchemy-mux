import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { listAll, MAX_RETRIES, Mux, MuxLive } from "../src/Api.ts";
import { Credentials } from "../src/Credentials.ts";
import { check } from "./lib.ts";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** Serves scripted replies in order and records each request. */
function fakeMux(replies: Reply[] | ((req: Request) => Reply)) {
  const seen: { url: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ url: req.url, authorization: req.headers.get("authorization") });
      const reply = typeof replies === "function" ? replies(req) : replies.shift()!;
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: reply.headers,
      });
    },
  });
  const layer = MuxLive.pipe(
    Layer.provide(
      Layer.succeed(
        Credentials,
        Effect.succeed({
          tokenId: Redacted.make("id"),
          tokenSecret: Redacted.make("secret"),
          apiBaseUrl: `http://localhost:${server.port}`,
        }),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
  const run = <A, E>(f: (mux: Mux["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* f(yield* Mux);
      }).pipe(Effect.provide(layer)),
    );
  return { seen, run, stop: () => server.stop(true) };
}

const failureTag = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "success";

export async function clientChecks() {
  {
    const fake = fakeMux([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200, body: { data: { id: "ok" } } },
    ]);
    const exit = await fake.run((mux) => mux.request<{ id: string }>("GET", "/x"));
    fake.stop();
    check(Exit.isSuccess(exit) && exit.value.id === "ok", `GET after two 429s: ${failureTag(exit)}`);
    check(fake.seen.length === 3, `GET after two 429s made ${fake.seen.length} requests, expected 3`);
    check(
      fake.seen[0].authorization === `Basic ${btoa("id:secret")}`,
      `basic auth header is ${fake.seen[0].authorization}`,
    );
  }
  {
    const fake = fakeMux([{ status: 500, body: { error: "boom" } }, { status: 201, body: { data: {} } }]);
    const exit = await fake.run((mux) => mux.request("POST", "/x", {}));
    fake.stop();
    check(Exit.isFailure(exit) && failureTag(exit).includes("MuxApiError"), "POST 500 should fail");
    check(fake.seen.length === 1, `POST 500 was retried (${fake.seen.length} requests); could duplicate`);
  }
  {
    const fake = fakeMux([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 201, body: { data: { id: "made" } } },
    ]);
    const exit = await fake.run((mux) => mux.request<{ id: string }>("POST", "/x", {}));
    fake.stop();
    check(Exit.isSuccess(exit) && exit.value.id === "made", `POST after 429: ${failureTag(exit)}`);
    check(fake.seen.length === 2, `POST after 429 made ${fake.seen.length} requests, expected 2`);
  }
  {
    const fake = fakeMux(() => ({ status: 503, headers: { "retry-after": "0" } }));
    const exit = await fake.run((mux) => mux.request("DELETE", "/x"));
    fake.stop();
    check(Exit.isFailure(exit) && failureTag(exit).includes("503"), "persistent 503 should fail");
    check(
      fake.seen.length === MAX_RETRIES + 1,
      `persistent 503 made ${fake.seen.length} requests, expected ${MAX_RETRIES + 1}`,
    );
  }
  {
    const fake = fakeMux([{ status: 404 }]);
    const exit = await fake.run((mux) => mux.request("DELETE", "/x"));
    fake.stop();
    check(failureTag(exit).includes("NotFound"), `404 should map to NotFound: ${failureTag(exit)}`);
  }
  {
    const items = Array.from({ length: 250 }, (_, i) => ({ id: i }));
    const fake = fakeMux((req) => {
      const url = new URL(req.url);
      const page = Number(url.searchParams.get("page"));
      const limit = Number(url.searchParams.get("limit"));
      return { status: 200, body: { data: items.slice((page - 1) * limit, page * limit) } };
    });
    const exit = await fake.run((mux) => listAll<{ id: number }>(mux, "/things"));
    fake.stop();
    check(Exit.isSuccess(exit) && exit.value.length === 250, `listAll returned ${Exit.isSuccess(exit) ? exit.value.length : failureTag(exit)} of 250`);
    check(fake.seen.length === 3, `listAll made ${fake.seen.length} requests, expected 3`);
  }
  return "retry, no-duplicate POST, retry cap, 404 mapping, pagination, auth";
}
