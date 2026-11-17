export {};
const out = process.argv[2] ?? "src/generated/mux-api.ts";
const proc = Bun.spawn(
  ["bunx", "openapi-typescript", "spec/mux-api-spec.json", "-o", out, "--default-non-nullable", "false"],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(await proc.exited);
