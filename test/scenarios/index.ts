import { access } from "./access.ts";
import { annotation_ } from "./annotation.ts";
import { asset_ } from "./asset.ts";
import { bindings } from "./bindings.ts";
import { example } from "./example.ts";
import { liveStream } from "./live-stream.ts";
import { webhook } from "./webhook.ts";

export const scenarios = [webhook, liveStream, access, annotation_, asset_, bindings, example];
