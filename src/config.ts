import * as v from "valibot";

// The npm package version — single source of truth is package.json, so the MCP
// server's reported version (serverInfo.version) never drifts from the
// published release.
export const VERSION = (
  await Bun.file(new URL("../package.json", import.meta.url)).json()
).version as string;

const ConfigSchema = v.object({
  headless: v.optional(v.boolean(), true),
  viewportW: v.optional(v.number(), 1280),
  viewportH: v.optional(v.number(), 800),
  timeoutMs: v.optional(v.number(), 15000),
  outputDir: v.optional(v.string(), ".browser-use"),
  outputMaxChars: v.optional(v.number(), 4000),
  allowEval: v.optional(v.boolean(), false),
  deltaDefault: v.optional(v.boolean(), true),
  effectMaxChars: v.optional(v.number(), 800),
  stateMaxLines: v.optional(v.number(), 40),
  recordRedact: v.optional(v.boolean(), true),
  effingUseUrl: v.optional(v.string(), "http://localhost:3123/mcp"),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

export function loadConfig(): Config {
  return v.parse(ConfigSchema, {
    headless: process.env.BROWSER_HEADLESS !== "false",
    viewportW: Number(process.env.BROWSER_VIEWPORT_W ?? 1280),
    viewportH: Number(process.env.BROWSER_VIEWPORT_H ?? 800),
    timeoutMs: Number(process.env.BROWSER_TIMEOUT_MS ?? 15000),
    outputDir: process.env.OUTPUT_DIR ?? ".browser-use",
    outputMaxChars: Number(process.env.OUTPUT_MAX_CHARS ?? 4000),
    allowEval: process.env.ALLOW_EVAL === "true",
    deltaDefault: process.env.DELTA_DEFAULT !== "false",
    effectMaxChars: Number(process.env.EFFECT_MAX_CHARS ?? 800),
    stateMaxLines: Number(process.env.STATE_MAX_LINES ?? 40),
    recordRedact: process.env.RECORD_REDACT !== "false",
    effingUseUrl: process.env.EFFING_USE_URL ?? "http://localhost:3123/mcp",
  });
}
