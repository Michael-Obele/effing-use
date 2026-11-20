import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { flushJournal, readJournal } from "../src/browser/journal.js";
import { doObserve } from "../src/browser/engine.js";
import { closeAll, getPage } from "../src/browser/session.js";

const live = process.env.EFFING_LIVE_TEST === "1";

(live ? describe : describe.skip)("journal live capture", () => {
  let stopServer: (() => void) | null = null;
  let outputDir = "";

  afterAll(async () => {
    await closeAll();
    stopServer?.();
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  test("captures console error, pageerror, 404, and navigation", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/missing") {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          `<!doctype html><html><body><script>
            console.error("boom-console");
            setTimeout(() => { throw new Error("boom-pageerror"); }, 10);
            fetch("/missing").catch(() => {});
          </script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    stopServer = () => server.stop(true);
    const port = server.port!;

    outputDir = await mkdtemp(join(tmpdir(), "effing-live-"));
    const config: Config = { ...loadConfig(), outputDir };

    const page = await getPage(config, "live");
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForTimeout(500);
    await flushJournal("live");

    const { events } = await readJournal(config, "live");

    expect(
      events.some((e) => e.type === "console" && e.level === "error"),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "pageerror" &&
          String(e.message).includes("boom-pageerror"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "response" && e.status === 404)).toBe(
      true,
    );
    expect(
      events.some(
        (e) => e.type === "response" && typeof e.requestId === "string",
      ),
    ).toBe(true);
  });

  test("falls back to in-memory rings when journaling is disabled", async () => {
    const config: Config = { ...loadConfig(), outputDir, journal: false };
    const page = await getPage(config, "ring-only");
    await page.setContent('<script>console.error("ring-only")</script>');
    await page.waitForTimeout(100);

    const result = await doObserve(page, config, "console", undefined, 10, {
      sessionId: "ring-only",
    });
    const logs = (result as { logs: Array<{ text: string }> }).logs;
    expect(logs.some((l) => l.text.includes("ring-only"))).toBe(true);
  });
});
