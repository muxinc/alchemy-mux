import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientChecks } from "./client.ts";
import { sweep } from "./sweep.ts";
import { alchemy, check, CheckFailed, mux, stateOf } from "./lib.ts";
import type { Scenario } from "./scenario.ts";
import { scenarios } from "./scenarios/index.ts";

const results: { gate: string; ok: boolean; detail: string }[] = [];

async function gate(name: string, body: () => Promise<string | void>) {
  const started = performance.now();
  try {
    const detail = (await body()) ?? "";
    const ms = Math.round(performance.now() - started);
    results.push({ gate: name, ok: true, detail: `${detail} (${ms}ms)`.trim() });
    console.log(`  PASS  ${name}  ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ gate: name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail.split("\n").join("\n        ")}`);
    throw error;
  }
}

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: out + err };
}

async function credentials() {
  check(process.env.MUX_TOKEN_ID, "MUX_TOKEN_ID is not set");
  check(process.env.MUX_TOKEN_SECRET, "MUX_TOKEN_SECRET is not set");
  const res = await mux("GET", "/system/v1/whoami");
  check(res.status === 200, `whoami returned ${res.status}; the token is invalid`);
  const me = res.data;
  check(
    me.environment_type !== "production",
    `Refusing to run against production environment "${me.environment_name}". Use a development token.`,
  );
  for (const permission of ["video:write", "system:write", "robots:write", "data:write"]) {
    check(
      me.permissions.includes(permission),
      `Token lacks ${permission} (has ${me.permissions.join(", ")})`,
    );
  }
  return `${me.environment_name} (${me.environment_type})`;
}

async function generatedTypes() {
  const out = join(mkdtempSync(join(tmpdir(), "mux-gen-")), "mux-api.ts");
  const gen = await run(["bun", "scripts/generate.ts", out]);
  check(gen.code === 0, `openapi-typescript failed:\n${gen.output}`);
  check(
    readFileSync(out, "utf8") === readFileSync("src/generated/mux-api.ts", "utf8"),
    "src/generated/mux-api.ts is stale. Run `bun run generate`.",
  );
}

async function typecheck() {
  const tsc = await run(["bunx", "tsc", "--noEmit"]);
  check(tsc.code === 0, `tsc failed:\n${tsc.output}`);
}

async function lifecycle(scenario: Scenario, runId: string) {
  const stage = `verify-${runId}`;
  process.env.VERIFY_STAGE = stage;
  const env = { MUX_TEST_RUN: runId, MUX_TEST_PHASE: "" };
  const seen = new Map<string, { origin: string; id: string; attrs: Record<string, any> }>();
  let previous: Record<string, Record<string, any> | undefined> = {};
  const snapshot = () =>
    Object.fromEntries(
      Object.keys(scenario.resources).map((id) => [id, stateOf(scenario.stack, stage, id)]),
    );

  let failure: unknown;
  try {
    for (const phase of scenario.phases) {
      const label = `${scenario.name}/${phase.name}`;
      env.MUX_TEST_PHASE = phase.name;
      await phase.before?.({ run: runId, previous });
      try {
        const deploy = await alchemy(
          "deploy",
          scenario.stackFile,
          stage,
          env,
          phase.detectDrift ? ["--detect-drift"] : [],
        );
        if (phase.failsWith) {
          check(deploy.exitCode !== 0, `${label}: deploy should have failed but exited 0`);
          check(
            deploy.log.includes(phase.failsWith),
            `${label}: failure did not mention "${phase.failsWith}"\n${tail(deploy.log)}`,
          );
        } else {
          check(deploy.exitCode === 0, `${label}: deploy exited ${deploy.exitCode}\n${tail(deploy.log)}`);
          check(
            sameEntries(deploy.plan, phase.plan),
            `${label}: plan was ${JSON.stringify(deploy.plan)}, expected ${JSON.stringify(phase.plan)}`,
          );
        }
        const state = snapshot();
        for (const [id, attrs] of Object.entries(state)) {
          if (attrs) seen.set(scenario.resources[id](attrs), { origin: `${label}:${id}`, id, attrs });
        }
        try {
          await phase.verify?.({ run: runId, state, previous });
          for (const [id, attrs] of Object.entries(state)) {
            if (attrs) await scenario.matchesMux?.[id]?.(attrs);
          }
        } catch (error) {
          if (error instanceof CheckFailed) throw new CheckFailed(`${label}: ${error.message}`);
          throw error;
        }
        if (!phase.failsWith) {
          const again = await alchemy("deploy", scenario.stackFile, stage, env);
          check(again.exitCode === 0, `${label}: idempotent redeploy exited ${again.exitCode}`);
          const changed = Object.entries(again.plan).filter(([, action]) => action !== "noop");
          check(
            changed.length === 0,
            `${label}: redeploy with unchanged props planned ${JSON.stringify(Object.fromEntries(changed))}`,
          );
        }
        previous = state;
      } finally {
        await phase.after?.({ run: runId });
      }
    }
  } catch (error) {
    failure = error;
  }

  const cleanup: string[] = [];
  const destroy = await alchemy("destroy", scenario.stackFile, stage, env);
  if (destroy.exitCode !== 0) cleanup.push(`destroy exited ${destroy.exitCode}\n${tail(destroy.log)}`);
  for (const [path, { origin, id, attrs }] of seen) {
    if (scenario.retained?.includes(id)) {
      const kept = (await mux("GET", path)).status === 200;
      const removed = (await mux("DELETE", path)).status;
      if (!kept) cleanup.push(`${path} (from ${origin}) was retained but is gone after destroy`);
      if (removed !== 204 && removed !== 404) cleanup.push(`LEAK: could not delete retained ${path}: ${removed}`);
      continue;
    }
    const custom = scenario.isGone?.[id];
    const gone = custom ? await custom(attrs) : (await mux("GET", path)).status === 404;
    if (!gone) cleanup.push(`LEAK: ${path} (from ${origin}) still exists after destroy`);
  }
  if (failure || cleanup.length) {
    const reason = failure instanceof Error ? failure.message : failure ? String(failure) : "";
    throw new CheckFailed([reason, ...cleanup].filter(Boolean).join("\n"));
  }
  return `${scenario.phases.length} phases, ${seen.size} Mux objects created and confirmed deleted`;
}

const sameEntries = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

const tail = (log: string) =>
  log
    .trim()
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .slice(-15)
    .join("\n");

const only = process.argv.slice(2);
const selected = only.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
const runId = Date.now().toString(36);

console.log(`alchemy-mux verify  run=${runId}  scenarios=${selected.map((s) => s.name).join(",")}\n`);
try {
  await gate("1. credentials valid, non-production, video+system+robots+data write", credentials);
  await gate("2. generated types match vendored OpenAPI spec", generatedTypes);
  await gate("3. typecheck", typecheck);
  await gate("4. API client behavior against a fake server", clientChecks);
  for (const scenario of selected) {
    await gate(`5. lifecycle: ${scenario.name}`, () => lifecycle(scenario, runId));
  }
  await gate("6. sweep: nothing from this run remains in Mux", () => sweep(runId));
  console.log(`\nALL ${results.length} GATES PASSED`);
} catch (error) {
  if (!(error instanceof CheckFailed)) console.error(error);
  console.log(`\nFAILED at "${results.at(-1)?.gate}"`);
  process.exit(1);
}
