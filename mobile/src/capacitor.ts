import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type CapacitorInfo = {
  appId: string;
  appName?: string;
  /** `server.url` — set during live reload; the WebView is then not local. */
  serverUrl?: string;
  /**
   * CapacitorHttp patches fetch/XHR to run through native code, so the CDP
   * Network domain sees nothing. Knowing this up front is the difference
   * between "the app made no requests" and a wrong conclusion.
   */
  capacitorHttp: boolean;
  source: string;
};

const CANDIDATES = [
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.mjs",
  "capacitor.config.json",
];

function pick(block: string, key: string): string | undefined {
  const m = new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`).exec(block);
  return m?.[1];
}

/**
 * Read the Capacitor project config without importing it.
 *
 * `capacitor.config.ts` is executable TypeScript; importing it would run the
 * user's code inside this server. The two facts we need are plain strings, so a
 * targeted regex is the safe read — and a config using computed values simply
 * yields nothing, which the caller reports as "appId unknown".
 */
export function readCapacitorConfig(
  dir: string = process.cwd(),
): CapacitorInfo | null {
  for (const name of CANDIDATES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    if (name.endsWith(".json")) {
      try {
        const json = JSON.parse(raw) as Record<string, unknown>;
        const appId = typeof json.appId === "string" ? json.appId : undefined;
        if (!appId) continue;
        const server = (json.server ?? {}) as Record<string, unknown>;
        const plugins = (json.plugins ?? {}) as Record<string, unknown>;
        const http = (plugins.CapacitorHttp ?? {}) as Record<string, unknown>;
        return {
          appId,
          appName: typeof json.appName === "string" ? json.appName : undefined,
          serverUrl: typeof server.url === "string" ? server.url : undefined,
          capacitorHttp: http.enabled === true,
          source: path,
        };
      } catch {
        continue;
      }
    }
    const appId = pick(raw, "appId");
    if (!appId) continue;
    const pluginBlock = /CapacitorHttp\s*:\s*\{[^}]*\}/.exec(raw)?.[0] ?? "";
    return {
      appId,
      appName: pick(raw, "appName"),
      serverUrl: pick(raw, "url"),
      capacitorHttp: /enabled\s*:\s*true/.test(pluginBlock),
      source: path,
    };
  }
  return null;
}
