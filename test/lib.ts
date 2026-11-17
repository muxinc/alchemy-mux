import { existsSync, readFileSync } from "node:fs";

export type PlanAction = "create" | "update" | "replace" | "noop" | "delete";

export class CheckFailed extends Error {}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

/** Raw Mux client for assertions. Deliberately shares no code with src/. */
export async function mux(method: string, path: string, body?: unknown) {
  const auth = btoa(`${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.mux.com${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 8) {
      await Bun.sleep(Number(res.headers.get("retry-after") ?? 1) * 1000 || 1000);
      continue;
    }
    return { status: res.status, data: text ? JSON.parse(text).data : undefined };
  }
}

export interface DeployResult {
  exitCode: number;
  plan: Record<string, PlanAction>;
  log: string;
}

const PLAN_LINE = /INFO: \[([^\]]+)\] (create|update|replace|noop|delete)$/;

export async function alchemy(
  command: "deploy" | "destroy",
  stackFile: string,
  stage: string,
  env: Record<string, string>,
  flags: string[] = [],
): Promise<DeployResult> {
  const proc = Bun.spawn(
    ["bunx", "alchemy", command, stackFile, "--stage", stage, "--yes", "--no-input", ...flags],
    { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const log = out + err;
  const plan: Record<string, PlanAction> = {};
  for (const line of log.split("\n")) {
    const match = line.trim().match(PLAN_LINE);
    // A drift deploy prints the repair plan first, then the deploy plan.
    if (match && !(match[1] in plan)) plan[match[1]] = match[2] as PlanAction;
  }
  return { exitCode, plan, log };
}

/** A resource's attributes as Alchemy persisted them, with redacted values unwrapped. */
export function stateOf(stack: string, stage: string, id: string): Record<string, any> | undefined {
  const file = `.alchemy/state/${stack}/${stage}/${id}.json`;
  if (!existsSync(file)) return undefined;
  return unredact(JSON.parse(readFileSync(file, "utf8")).attr);
}

/** A resource's type and the props Alchemy last deployed (or attempted, after a failure). */
export function rowOf(stack: string, stage: string, id: string): { type: string; props: Record<string, unknown> } | undefined {
  const file = `.alchemy/state/${stack}/${stage}/${id}.json`;
  if (!existsSync(file)) return undefined;
  const row = JSON.parse(readFileSync(file, "utf8"));
  return { type: row.resourceType, props: row.props ?? {} };
}

function unredact(value: any): any {
  if (Array.isArray(value)) return value.map(unredact);
  if (value && typeof value === "object") {
    if ("__redacted__" in value) return value.__redacted__;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unredact(v)]));
  }
  return value;
}

/** Fails when the persisted attributes disagree with Mux on any of `fields`. */
/** Fields Mux returns in no stable order. */
const UNORDERED = new Set(["playback_ids"]);

const canonical = (field: string, value: unknown) =>
  JSON.stringify(
    UNORDERED.has(field) && Array.isArray(value)
      ? value.map((v) => JSON.stringify(v)).sort()
      : (value ?? null),
  );

export function same(label: string, persisted: Record<string, any>, live: Record<string, any>, fields: string[]) {
  for (const field of fields) {
    const a = canonical(field, persisted[field]);
    const b = canonical(field, live?.[field]);
    check(a === b, `${label}.${field}: state has ${a} but Mux has ${b}`);
  }
}
