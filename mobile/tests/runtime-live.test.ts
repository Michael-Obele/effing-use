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

  test.skipIf(!LIVE || !CHROME)(
    "scrollProbe finds the scroller and keeps its point inside it",
    async () => {
      // A page whose only scrollable region is a narrow horizontal strip, the
      // shape that broke the first scroll implementation: the gesture must be
      // dispatched inside that strip, and at max scroll the centred element is
      // no longer a valid target.
      const dir = mkdtempSync(join(tmpdir(), "effing-scroll-"));
      const file = join(dir, "scroll.html");
      writeFileSync(
        file,
        `<!doctype html><html><head><title>Scroll</title>
<style>
  body { margin: 0 }
  #rail { position: absolute; left: 20px; top: 40px; width: 300px; height: 120px;
          overflow-x: scroll; display: flex; gap: 8px; }
  #rail > a { flex: 0 0 140px; height: 100px; }
  #tail { position: absolute; left: 0; right: 0; top: 400px; height: 80px; }
</style></head>
<body>
  <div id="rail">
    ${Array.from({ length: 12 }, (_, i) => `<a href="#${i}">cell ${i}</a>`).join("\n    ")}
  </div>
  <div id="tail"><button id="elsewhere">Elsewhere</button></div>
</body></html>`,
      );
      const { child, port } = await startChrome();
      try {
        const wsUrl = await newPage(port, `file://${file}`);
        const cdp = await Cdp.connect(wsUrl);
        // Desktop headless Chrome is not a touch device, so a touch gesture
        // scrolls nothing. Emulate a phone, which is what the product runs on.
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 1,
        });
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 412,
          height: 843,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await injectRuntime(cdp);

        type Probe = {
          point: { x: number; y: number };
          scroller: string;
          left: number;
          maxLeft: number;
          maxTop: number;
        };
        const probe = (target: unknown, axis: string) =>
          callWithRuntime<Probe>(cdp, "scrollProbe", [target, axis]);
        const railLeft = async () =>
          (
            (await cdp.send("Runtime.evaluate", {
              expression:
                "Math.round(document.getElementById('rail').scrollLeft)",
              returnByValue: true,
            })) as { result: { value: number } }
          ).result.value;

        const before = await probe("#rail", "x");
        expect(before.scroller).toContain("#rail");
        expect(before.maxLeft).toBeGreaterThan(100);
        expect(before.left).toBe(0);

        // The point must land inside the strip, not at the viewport centre
        // (which is over #tail here and would scroll nothing).
        const rail = (await cdp.send("Runtime.evaluate", {
          expression: `(() => { const b = document.getElementById('rail').getBoundingClientRect();
            return JSON.stringify({ top: b.top, bottom: b.bottom, left: b.left, right: b.right }) })()`,
          returnByValue: true,
        })) as { result: { value: string } };
        const r = JSON.parse(rail.result.value) as Record<string, number>;
        expect(before.point.y).toBeGreaterThan(r.top);
        expect(before.point.y).toBeLessThan(r.bottom);
        expect(before.point.x).toBeGreaterThan(r.left);
        expect(before.point.x).toBeLessThan(r.right);

        // Scroll to the very end, then probe again: the point must STILL be
        // inside the strip. This is the regression that made "scroll left" fail
        // at max scroll, because the centred cell had moved past the right edge.
        //
        // Same pair `act` uses: touch first, mouse as the fallback. Headless
        // desktop Chrome ignores touch-source gestures even with touch emulated
        // (measured: scrollLeft stayed 0), so the mouse path is what runs here;
        // on a device the touch path is the one that fires.
        const gesture = (source: "touch" | "mouse") =>
          cdp.send("Input.synthesizeScrollGesture", {
            x: before.point.x,
            y: before.point.y,
            xDistance: -2000,
            yDistance: 0,
            gestureSourceType: source,
            speed: 4000,
            preventFling: true,
          });
        await gesture("touch");
        await new Promise((res) => setTimeout(res, 300));
        let shifted = await railLeft();
        if (shifted === 0) {
          await gesture("mouse");
          await new Promise((res) => setTimeout(res, 300));
          shifted = await railLeft();
        }
        expect(shifted).toBeGreaterThan(100);

        const atEnd = await probe("#rail", "x");
        expect(atEnd.point.y).toBeGreaterThan(r.top);
        expect(atEnd.point.y).toBeLessThan(r.bottom);
        expect(atEnd.point.x).toBeGreaterThan(r.left);
        expect(atEnd.point.x).toBeLessThan(r.right);

        // And a target outside the strip must report the strip, not the page.
        const viaRef = await probe(
          (await callWithRuntime<Snap>(cdp, "snapshot", [{ max: 40 }])).lines
            .split("\n")
            .findIndex((l) => l.includes("cell 1")),
          "x",
        );
        expect(viaRef.scroller).toContain("#rail");

        // With no target the probe follows the screen centre, whatever is
        // there — here #tail, which does not scroll sideways. Honest rather
        // than clever: the caller asked about the middle of the screen.
        const centre = await probe(null, "x");
        expect(centre.scroller).toBe("document");
        // The document tolerates sub-pixel overflow (measured 1 px here), so
        // "cannot scroll horizontally" means "essentially zero", not exactly 0.
        expect(centre.maxLeft).toBeLessThan(2);

        cdp.close();
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
