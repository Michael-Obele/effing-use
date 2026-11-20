import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read our own version from package.json at runtime so a release bump can never
 * leave the server reporting a stale number.
 *
 * The file's distance from package.json is not constant: two levels up in this
 * repo (`mobile/src/`), one when installed from npm
 * (`node_modules/effing-use-mobile/src/`), and something else again inside a
 * container. So walk up and match on the package name instead of hardcoding a
 * relative path — a fixed `../../package.json` silently breaks two of the three.
 */
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf-8"),
      ) as { name?: string; version?: string };
      if (pkg.name === "effing-use-mobile" && pkg.version) return pkg.version;
    } catch {
      // No package.json here (or unreadable); keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0-unknown";
}

export const MOBILE_VERSION: string = readVersion();

export type MobileConfig = {
  /** Serial from `adb devices`; unset means "the only attached device". */
  device?: string;
  /** Android package name; unset means "read capacitor.config.* in cwd". */
  package?: string;
  /**
   * Host that owns the adb forward. `127.0.0.1` when adb runs locally; inside a
   * container it is the machine running the adb server (host.docker.internal),
   * because `adb forward` listens on the adb server's host, not the client's.
   */
  cdpHost: string;
  outputDir: string;
  timeoutMs: number;
  outputMaxChars: number;
  domCapChars: number;
  snapshotMax: number;
  /**
   * Frames-plus-milliseconds to wait after a dispatched input event. Touch and
   * key events reach the page asynchronously, so a snapshot taken immediately
   * after a tap can still show the old DOM and report `unchanged`.
   */
  settleMs: number;
  allowEval: boolean;
  journal: boolean;
  journalMaxBytes: number;
  recordRedact: boolean;
};

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function loadMobileConfig(): MobileConfig {
  return {
    device: process.env.MOBILE_DEVICE || undefined,
    package: process.env.MOBILE_PACKAGE || undefined,
    cdpHost: process.env.MOBILE_CDP_HOST || "127.0.0.1",
    // Separate output dir so a mobile journal never lands in the browser's.
    outputDir: process.env.MOBILE_OUTPUT_DIR ?? ".effing-mobile",
    timeoutMs: num(process.env.MOBILE_TIMEOUT_MS, 20_000),
    outputMaxChars: num(process.env.MOBILE_OUTPUT_MAX_CHARS, 4000),
    domCapChars: num(process.env.MOBILE_DOM_CAP_CHARS, 20_000),
    snapshotMax: num(process.env.MOBILE_SNAPSHOT_MAX, 150),
    settleMs: num(process.env.MOBILE_SETTLE_MS, 120),
    // eval can mutate the app and reach native plugins; off unless asked.
    allowEval: flag(process.env.MOBILE_ALLOW_EVAL, false),
    journal: flag(process.env.MOBILE_JOURNAL, true),
    journalMaxBytes: num(process.env.MOBILE_JOURNAL_MAX_BYTES, 2_000_000),
    recordRedact: flag(process.env.MOBILE_REDACT, true),
  };
}
