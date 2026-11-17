import { check, mux } from "./lib.ts";

/** Lists every Mux object type and fails on anything tagged with this run's id. */
export async function sweep(runId: string) {
  const sources: [string, string, (item: any) => string | undefined][] = [
    ["webhooks", "/system/v1/webhooks", (w) => w.address],
    ["live streams", "/video/v1/live-streams", (l) => l.passthrough],
    ["assets", "/video/v1/assets", (a) => a.passthrough],
    ["directives", "/robots/v1/directives", (d) => d.name],
    ["annotations", "/data/v1/annotations", (a) => a.note],
    ["vocabularies", "/video/v1/transcription-vocabularies", (v) => v.name],
  ];
  const find = async () => {
    const found: { label: string; path: string; item: any; tag: string }[] = [];
    for (const [label, path, tag] of sources) {
      for (let page = 1; ; page++) {
        const items = (await mux("GET", `${path}?limit=100&page=${page}`)).data ?? [];
        for (const item of items) {
          const value = tag(item);
          if (value?.includes(runId)) found.push({ label, path, item, tag: value });
        }
        if (items.length < 100) break;
      }
    }
    return found;
  };
  // List endpoints can lag a delete by a few seconds; give them a minute.
  let leaks = await find();
  for (let attempt = 0; leaks.length > 0 && attempt < 6; attempt++) {
    await Bun.sleep(10_000);
    leaks = await find();
  }
  const report = await Promise.all(
    leaks.map(async (l) => `${l.label}: ${l.item.id} (${l.tag}), direct GET ${(await mux("GET", `${l.path}/${l.item.id}`)).status}`),
  );
  check(leaks.length === 0, `objects from this run remain in Mux:\n${report.join("\n")}`);
  return `${sources.length} object types checked`;
}
