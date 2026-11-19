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
  timeoutMs: v.optional(v.number(), 30000),
  outputDir: v.optional(v.string(), ".browser-use"),
  outputMaxChars: v.optional(v.number(), 4000),
  allowEval: v.optional(v.boolean(), false),
  deltaDefault: v.optional(v.boolean(), true),
  effectMaxChars: v.optional(v.number(), 800),
  stateMaxLines: v.optional(v.number(), 40),
  recordRedact: v.optional(v.boolean(), true),
  effingUseUrl: v.optional(v.string(), "http://localhost:3123/mcp"),
  // CPU / lifecycle tuning. All env-overridable, all have safe defaults so
  // existing setups see lower idle CPU with no config change.
  idleTtlMs: v.optional(v.number(), 300000),
  browserTtlMs: v.optional(v.number(), 600000),
  blockAssets: v.optional(v.array(v.string()), ["font", "media"]),
  reducedMotion: v.optional(v.boolean(), true),
  settleNetworkIdleMs: v.optional(v.number(), 800),
  domCapChars: v.optional(v.number(), 20000),
  journal: v.optional(v.boolean(), true),
  journalMaxBytes: v.optional(v.number(), 2_000_000),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

function parseJournalMaxBytes(raw: string | undefined): number {
  const DEFAULT = 2_000_000;
  if (raw === undefined) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT;
  return Math.max(10_000, Math.floor(n));
}

function parseBlockAssets(raw: string | undefined): string[] {
  if (raw === undefined) return ["font", "media"];
  const s = raw.trim().toLowerCase();
  if (s === "" || s === "0" || s === "false" || s === "none") return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  return v.parse(ConfigSchema, {
    headless: process.env.BROWSER_HEADLESS !== "false",
    viewportW: Number(process.env.BROWSER_VIEWPORT_W ?? 1280),
    viewportH: Number(process.env.BROWSER_VIEWPORT_H ?? 800),
    // 30s, not 15s: real sites (duckduckgo, tracker-heavy news pages) miss a
    // 15s domcontentloaded deadline even though the page is fine. `navigate()`
    // also degrades gracefully on a slow load, so a generous default no longer
    // costs anything on fast pages.
    timeoutMs: Number(process.env.BROWSER_TIMEOUT_MS ?? 30000),
    outputDir: process.env.OUTPUT_DIR ?? ".browser-use",
    outputMaxChars: Number(process.env.OUTPUT_MAX_CHARS ?? 4000),
    allowEval: process.env.ALLOW_EVAL === "true",
    deltaDefault: process.env.DELTA_DEFAULT !== "false",
    effectMaxChars: Number(process.env.EFFECT_MAX_CHARS ?? 800),
    stateMaxLines: Number(process.env.STATE_MAX_LINES ?? 40),
    recordRedact: process.env.RECORD_REDACT !== "false",
    effingUseUrl: process.env.EFFING_USE_URL ?? "http://localhost:3123/mcp",
    idleTtlMs: Number(process.env.EFFING_IDLE_TTL_MS ?? 300000),
    browserTtlMs: Number(process.env.EFFING_BROWSER_TTL_MS ?? 600000),
    blockAssets: parseBlockAssets(process.env.EFFING_BLOCK_ASSETS),
    reducedMotion: process.env.EFFING_REDUCED_MOTION !== "0",
    settleNetworkIdleMs: Number(process.env.EFFING_SETTLE_IDLE_MS ?? 800),
    domCapChars: Number(process.env.EFFING_DOM_CAP ?? 20000),
    journal:
      process.env.EFFING_JOURNAL !== "false" &&
      process.env.EFFING_JOURNAL !== "0",
    journalMaxBytes: parseJournalMaxBytes(process.env.EFFING_JOURNAL_MAX_BYTES),
  });
}
