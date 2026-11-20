import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "../src/cdp.js";
import { callWithRuntime, injectRuntime } from "../src/page.js";

/**
 * Behavioural test of the in-page runtime, against real Chrome and a real DOM.
 *
 * Opt-in (MOBILE_LIVE_TEST=1) because it needs a Chrome binary; it exists
 * because the snapshot, the shadow-DOM piercing and the controlled-input fill
 * are the whole product and cannot be proven by unit-testing strings. The same
 * code path runs over adb on a device — only the socket differs.
 */

const LIVE = process.env.MOBILE_LIVE_TEST === "1";
const CHROME =
  process.env.CHROME_PATH ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => {
    try {
      return Bun.file(p).size > 0;
    } catch {
      return false;
    }
  });

type Box = {
  stale?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  tag: string;
};
type Snap = { title: string; count: number; lines: string };

const FIXTURE = `<!doctype html>
<html><head><title>Fixture</title></head>
<body>
  <h1>Hello</h1>
  <button id="go">Sign in</button>
  <input id="email" placeholder="Email">
  <div role="button" aria-label="Close">x</div>
  <div style="display:none"><button id="ghost">Ghost</button></div>
  <div aria-hidden="true"><button id="aria">Aria hidden</button></div>
  <my-field></my-field>
  <script>
    window.__events = [];
    // Two observers, two different truths: the shadow listener sees the real
    // target and value (how Ionic binds its own controls), while document only
    // sees the retargeted host — but it must still see the event at all, which
    // only happens when the input event is composed.
    document.addEventListener('input', (e) => window.__events.push('doc:' + e.composedPath()[0].id));
    customElements.define('my-field', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<label>Amount</label><input id="inner" placeholder="Amount">';
        r.querySelector('input').addEventListener('input', (e) => window.__events.push('inner:' + e.target.value));
      }
    });
  </script>
</body></html>`;

function startChrome(): Promise<{ child: ChildProcess; port: number }> {
  const profile = mkdtempSync(join(tmpdir(), "effing-chrome-"));
  const child = spawn(
    CHROME as string,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(
      () => reject(new Error(`chrome did not start: ${err.slice(-400)}`)),
      20_000,
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      // Chrome picks a free port and announces it; no port collisions, ever.
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`chrome exited early (${code}): ${err.slice(-400)}`));
    });
  });
}

async function newPage(port: number, url: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, {
    method: "PUT",
  });
  const target = (await res.json()) as { webSocketDebuggerUrl: string };
  return target.webSocketDebuggerUrl;
}

describe("webview runtime (live)", () => {
  test.skipIf(!LIVE || !CHROME)(
    "snapshot, stale refs, shadow DOM and fill",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "effing-fixture-"));
      const file = join(dir, "fixture.html");
      writeFileSync(file, FIXTURE);
      const { child, port } = await startChrome();
      try {
        const wsUrl = await newPage(port, `file://${file}`);
        const cdp = await Cdp.connect(wsUrl);
        await injectRuntime(cdp);

        const snap = await callWithRuntime<Snap>(cdp, "snapshot", [
          { max: 50 },
        ]);
        expect(snap.title).toBe("Fixture");
        // Visible interactive elements only: the display:none and aria-hidden
        // branches must not appear, or an agent taps things it cannot see.
        expect(snap.lines).toContain('button "Sign in"');
        expect(snap.lines).toContain('input "Email"');
        expect(snap.lines).toContain('div "x"');
        expect(snap.lines).not.toContain("Ghost");
        expect(snap.lines).not.toContain("Aria hidden");
        expect(snap.lines).toContain("my-field");

        const goIndex = Number(
          /\[e(\d+)\] button "Sign in"/.exec(snap.lines)![1],
        );
        const box = await callWithRuntime<Box>(cdp, "box", [goIndex]);
        expect(box.tag).toBe("button");
        expect(box.x).toBeGreaterThan(0);
        expect(box.y).toBeGreaterThan(0);

        // The shadow-DOM host must resolve to its native control, and filling it
        // must fire the events a framework listens for.
        const fieldIndex = snap.lines
          .split("\n")
          .findIndex((l) => l.includes("my-field"));
        expect(fieldIndex).toBeGreaterThanOrEqual(0);
        const filled = await callWithRuntime<{ ok?: boolean; value?: string }>(
          cdp,
          "fill",
          [fieldIndex, "42"],
        );
        expect(filled.value).toBe("42");
        const events = (await cdp.send("Runtime.evaluate", {
          expression: "JSON.stringify(window.__events)",
          returnByValue: true,
        })) as { result: { value: string } };
        expect(events.result.value).toContain("inner:42");
        expect(events.result.value).toContain("doc:inner");

        // Navigating away leaves refs pointing at a dead document. The next call
        // must say stale (or the refs must be rebuilt), never click blindly.
        await cdp.send("Runtime.evaluate", {
          expression: "document.body.innerHTML = '<button>Next</button>'",
        });
        const stale = await callWithRuntime<Box>(cdp, "box", [goIndex]);
        expect(stale.stale).toBe(true);

        cdp.close();
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
