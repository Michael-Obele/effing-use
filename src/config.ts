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
  });
}
