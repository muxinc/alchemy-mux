import { playbackIdChanges } from "../src/Converge.ts";
import { check } from "./lib.ts";

const ids = (list: ReadonlyArray<{ id?: string }>) => list.map((p) => p.id).join(",");

export async function convergeChecks() {
  const drmA = { policy: "drm", drm_configuration_id: "cfg-a" };
  const drmB = { policy: "drm", drm_configuration_id: "cfg-b" };

  const a = playbackIdChanges([drmA], [{ id: "x", ...drmB }]);
  check(a.create.length === 1 && ids(a.remove) === "x", "DRM ID with another configuration was kept");

  const b = playbackIdChanges([drmA], [{ id: "x", ...drmA }, { id: "y", ...drmA }]);
  check(b.create.length === 0 && ids(b.remove) === "y", "second DRM ID for one configuration was kept");

  const c = playbackIdChanges([{ policy: "public" }, { policy: "signed" }], [{ id: "p", policy: "public" }]);
  check(c.create.length === 1 && c.create[0]!.policy === "signed" && c.remove.length === 0, "missing signed ID not created");

  const d = playbackIdChanges([{ policy: "public" }, { policy: "public" }], [{ id: "p", policy: "public" }]);
  check(d.create.length === 1 && d.remove.length === 0, "two wanted public IDs paired with one live ID");

  return "DRM configuration, duplicates, missing and repeated policies";
}
