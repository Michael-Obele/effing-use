import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME } from "../src/runtime.js";
import { readCapacitorConfig } from "../src/capacitor.js";
import { buildHar } from "../src/har.js";
import { MobileError, toEnvelope } from "../src/errors.js";
import { MOBILE_VERSION, loadMobileConfig } from "../src/config.js";

describe("version", () => {
  // A hardcoded `../../package.json` resolves in this repo and breaks both for
  // an npm install and inside the container — it did, until this test's subject
  // was rewritten to walk up and match the package name.
  test("resolves from package.json, wherever the file sits", () => {
    expect(MOBILE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(MOBILE_VERSION).not.toBe("0.0.0-unknown");
  });

  test("every version knob has a default that needs no env", () => {
    const cfg = loadMobileConfig();
    expect(cfg.outputDir).toBeTruthy();
    expect(cfg.cdpHost).toBeTruthy();
    expect(cfg.snapshotMax).toBeGreaterThan(0);
    expect(cfg.allowEval).toBe(false);
  });
});

describe("webview runtime", () => {
  // The script is assembled in TypeScript. A `${` inside it would be
  // interpolated here and fail only at attach time, on a real device.
  test("contains no template interpolation", () => {
    expect(RUNTIME.includes("${")).toBe(false);
  });

  test("parses as JavaScript", () => {
    expect(() => new Function(RUNTIME)).not.toThrow();
  });

  test("exposes the calls the tools use", () => {
    for (const fn of [
      "snapshot",
      "box",
      "domBox",
      "focusBox",
      "fill",
      "text",
      "html",
      "table",
      "query",
      "state",
      "plugins",
      "hook",
    ]) {
      expect(RUNTIME).toContain(`${fn}: ${fn}`);
    }
  });
});

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "effing-mobile-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

describe("capacitor config", () => {
  test("reads appId from capacitor.config.ts", () => {
    const dir = tempProject({
      "capacitor.config.ts": `import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'com.acme.app',
  appName: 'Acme',
  webDir: 'dist',
  server: { url: 'http://192.168.1.5:5173', cleartext: true },
  plugins: { CapacitorHttp: { enabled: true } },
};
export default config;`,
    });
    const info = readCapacitorConfig(dir);
    expect(info?.appId).toBe("com.acme.app");
    expect(info?.serverUrl).toBe("http://192.168.1.5:5173");
    expect(info?.capacitorHttp).toBe(true);
  });

  test("reads capacitor.config.json and defaults capacitorHttp off", () => {
    const dir = tempProject({
      "capacitor.config.json": JSON.stringify({
        appId: "io.example.mobile",
        plugins: { CapacitorHttp: { enabled: false } },
      }),
    });
    const info = readCapacitorConfig(dir);
    expect(info?.appId).toBe("io.example.mobile");
    expect(info?.capacitorHttp).toBe(false);
    expect(info?.serverUrl).toBeUndefined();
  });

  test("returns null without a config", () => {
    expect(readCapacitorConfig(tempProject({}))).toBeNull();
  });

  test("does not execute a config it cannot read statically", () => {
    const dir = tempProject({
      "capacitor.config.ts": `const appId = process.env.APP_ID;\nexport default { appId };`,
    });
    // Computed values are reported as unknown rather than guessed.
    expect(readCapacitorConfig(dir)).toBeNull();
  });
});

describe("HAR", () => {
  test("maps the network ring to HAR 1.2 entries", () => {
    const har = buildHar(
      [
        { method: "GET", url: "https://api.test/me", status: 200, ms: 42 },
        {
          method: "POST",
          url: "https://api.test/upload",
          error: "net::ERR_ABORTED",
        },
      ],
      "capacitor://localhost/",
    ) as {
      log: {
        version: string;
        pages: Array<{ title: string }>;
        entries: Array<Record<string, unknown>>;
      };
    };
    expect(har.log.version).toBe("1.2");
    expect(har.log.pages[0].title).toBe("capacitor://localhost/");
    expect(har.log.entries).toHaveLength(2);
    const first = har.log.entries[0] as {
      time: number;
      request: { method: string; url: string };
      response: { status: number };
    };
    expect(first.time).toBe(42);
    expect(first.request.method).toBe("GET");
    expect(first.response.status).toBe(200);
    expect(har.log.entries[1]).toMatchObject({ _error: "net::ERR_ABORTED" });
  });
});

describe("error envelope", () => {
  test("keeps code, message and hint for a MobileError", () => {
    const env = toEnvelope(
      new MobileError("E_STALE", "Ref e3 is stale.", "Re-observe."),
      { journal: "/tmp/j.jsonl" },
    );
    expect(env).toMatchObject({
      ok: false,
      code: "E_STALE",
      message: "Ref e3 is stale.",
      hint: "Re-observe.",
      journal: "/tmp/j.jsonl",
    });
  });

  test("clips a multi-line adb failure to its first line", () => {
    const env = toEnvelope(new Error("error: device offline\nsecond line"));
    expect(env.code).toBe("E_MOBILE");
    expect(env.message).toBe("error: device offline");
  });
});
