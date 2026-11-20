import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import {
  appendCall,
  appendEvent,
  formatEventLine,
  journalPath,
  parseSince,
  readJournal,
  summarizeErrors,
  type JournalEvent,
} from "../src/browser/journal.js";

let outputDir: string;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    outputDir,
    journal: true,
    journalMaxBytes: 2_000_000,
    recordRedact: true,
    ...overrides,
  } as Config;
}

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "effing-journal-"));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe("appendEvent / readJournal round-trip", () => {
  test("preserves fields and adds seq/id/ts/sessionId", async () => {
    const config = makeConfig();
    const written = await appendEvent(config, "sess-1", {
      type: "navigation",
      url: "https://example.com",
    });
    expect(written).not.toBeNull();
    expect(written?.sessionId).toBe("sess-1");
    expect(typeof written?.seq).toBe("number");
    expect(typeof written?.id).toBe("string");
    expect(typeof written?.ts).toBe("string");

    const { events, total, truncated, path } = await readJournal(
      config,
      "sess-1",
    );
    expect(total).toBe(1);
    expect(truncated).toBe(false);
    expect(path).toBe(journalPath(config, "sess-1"));
    expect(events).toHaveLength(1);
    expect(events[0]?.url).toBe("https://example.com");
    expect(events[0]?.type).toBe("navigation");
    expect(events[0]?.sessionId).toBe("sess-1");
    expect(typeof events[0]?.seq).toBe("number");
  });

  test("uses the supplied ts instead of generating one", async () => {
    const config = makeConfig();
    const ts = "2020-01-01T00:00:00.000Z";
    const written = await appendEvent(config, "sess-ts", {
      type: "navigation",
      url: "https://example.com",
      ts,
    });
    expect(written?.ts).toBe(ts);
  });
});

describe("config.journal === false", () => {
  test("writes nothing and returns null", async () => {
    const config = makeConfig({ journal: false });
    const result = await appendEvent(config, "sess-off", { type: "crash" });
    expect(result).toBeNull();
    const { events, total } = await readJournal(config, "sess-off");
    expect(events).toHaveLength(0);
    expect(total).toBe(0);
  });
});

describe("readJournal filters", () => {
  async function seed(config: Config) {
    await appendEvent(config, "sess-f", {
      type: "console",
      level: "error",
      text: "boom",
      url: "https://a.test/",
      ts: "2024-01-01T00:00:00.000Z",
    });
    await appendEvent(config, "sess-f", {
      type: "console",
      level: "info",
      text: "hello",
      url: "https://b.test/",
      ts: "2024-01-01T00:00:01.000Z",
    });
    await appendEvent(config, "sess-f", {
      type: "navigation",
      url: "https://c.test/",
      ts: new Date().toISOString(),
    });
  }

  test("type filter accepts one or many", async () => {
    const config = makeConfig();
    await seed(config);
    const one = await readJournal(config, "sess-f", { type: "navigation" });
    expect(one.events).toHaveLength(1);
    const many = await readJournal(config, "sess-f", {
      type: ["console", "navigation"],
    });
    expect(many.events).toHaveLength(3);
  });

  test("level filter only applies to console events", async () => {
    const config = makeConfig();
    await seed(config);
    const { events } = await readJournal(config, "sess-f", {
      level: "ERROR",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("boom");
  });

  test("filter does case-insensitive substring match", async () => {
    const config = makeConfig();
    await seed(config);
    const { events } = await readJournal(config, "sess-f", {
      filter: "A.TEST",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.url).toBe("https://a.test/");
  });

  test("since (relative) excludes older events", async () => {
    const config = makeConfig();
    await seed(config);
    const { events } = await readJournal(config, "sess-f", { since: "1m" });
    // only the navigation event (ts = now) is within the last minute
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("navigation");
  });

  test("offset/limit apply after filtering, truncated reflects remainder", async () => {
    const config = makeConfig();
    await seed(config);
    const page1 = await readJournal(config, "sess-f", { limit: 2, offset: 0 });
    expect(page1.events).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.truncated).toBe(true);

    const page2 = await readJournal(config, "sess-f", { limit: 2, offset: 2 });
    expect(page2.events).toHaveLength(1);
    expect(page2.truncated).toBe(false);
  });
});

describe("redaction", () => {
  test("redacts nested authorization/password keys", async () => {
    const config = makeConfig({ recordRedact: true });
    await appendEvent(config, "sess-redact", {
      type: "call",
      tool: "act",
      key: "fill",
      durationMs: 1,
      ok: true,
      headers: { Authorization: "Bearer abc123" },
      nested: { password: "hunter2", safe: "kept" },
    });
    const { events } = await readJournal(config, "sess-redact");
    const e = events[0] as unknown as {
      headers: { Authorization: string };
      nested: { password: string; safe: string };
    };
    expect(e.headers.Authorization).toBe("«redacted»");
    expect(e.nested.password).toBe("«redacted»");
    expect(e.nested.safe).toBe("kept");
  });

  test("leaves fields untouched when recordRedact is false", async () => {
    const config = makeConfig({ recordRedact: false });
    await appendEvent(config, "sess-noredact", {
      type: "call",
      tool: "act",
      key: "fill",
      durationMs: 1,
      ok: true,
      secret: "plain",
    });
    const { events } = await readJournal(config, "sess-noredact");
    expect((events[0] as unknown as { secret: string }).secret).toBe("plain");
  });
});

describe("rotation", () => {
  test("rotates journal.jsonl to journal.1.jsonl once max bytes is exceeded", async () => {
    const config = makeConfig({ journalMaxBytes: 200 });
    for (let i = 0; i < 20; i++) {
      await appendEvent(config, "sess-rot", {
        type: "console",
        level: "log",
        text: `line-${i}-padding-padding-padding`,
      });
    }
    const rotatedPath = join(
      journalPath(config, "sess-rot").replace(/journal\.jsonl$/, ""),
      "journal.1.jsonl",
    );
    const rotatedFile = Bun.file(rotatedPath);
    expect(await rotatedFile.exists()).toBe(true);

    const { events, path } = await readJournal(config, "sess-rot");
    expect(path).toBe(journalPath(config, "sess-rot"));
    // rotated file content comes first, current file content last
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.seq).toBeGreaterThanOrEqual(events[i - 1]?.seq ?? 0);
    }
  });
});

describe("malformed lines", () => {
  test("skips corrupt JSONL lines and keeps valid records", async () => {
    const config = makeConfig();
    await appendEvent(config, "sess-bad", {
      type: "navigation",
      url: "https://ok.test/",
    });
    await appendFile(journalPath(config, "sess-bad"), "{not-json}\n", "utf-8");
    await appendEvent(config, "sess-bad", { type: "crash" });

    const { events } = await readJournal(config, "sess-bad");
    expect(events.map((e) => e.type)).toEqual(["navigation", "crash"]);
  });
});

describe("parseSince", () => {
  test("converts relative durations to an ISO timestamp", () => {
    const now = Date.parse("2024-06-01T12:00:00.000Z");
    const result = parseSince("5m", now);
    expect(result).toBe(new Date(now - 5 * 60_000).toISOString());
  });

  test("returns null for invalid input", () => {
    expect(parseSince("not-a-time")).toBeNull();
    expect(parseSince("")).toBeNull();
  });

  test("passes through valid ISO strings", () => {
    const iso = "2024-01-01T00:00:00.000Z";
    expect(parseSince(iso)).toBe(new Date(iso).toISOString());
  });
});

describe("summarizeErrors", () => {
  test("dedupes repeated page errors, console errors, and 500 responses", () => {
    const events: JournalEvent[] = [
      {
        type: "pageerror",
        message: "boom",
        name: "TypeError",
        seq: 1,
        id: "1",
        ts: "2024-01-01T00:00:00.000Z",
        sessionId: "s",
      },
      {
        type: "pageerror",
        message: "boom",
        name: "TypeError",
        seq: 2,
        id: "2",
        ts: "2024-01-01T00:00:01.000Z",
        sessionId: "s",
      },
      {
        type: "console",
        level: "error",
        text: "bad",
        url: "https://a.test/",
        seq: 3,
        id: "3",
        ts: "2024-01-01T00:00:02.000Z",
        sessionId: "s",
      },
      {
        type: "console",
        level: "error",
        text: "bad",
        url: "https://a.test/",
        seq: 4,
        id: "4",
        ts: "2024-01-01T00:00:03.000Z",
        sessionId: "s",
      },
      {
        type: "response",
        method: "GET",
        url: "https://a.test/api",
        status: 500,
        seq: 5,
        id: "5",
        ts: "2024-01-01T00:00:04.000Z",
        sessionId: "s",
      },
      {
        type: "response",
        method: "GET",
        url: "https://a.test/api",
        status: 500,
        seq: 6,
        id: "6",
        ts: "2024-01-01T00:00:05.000Z",
        sessionId: "s",
      },
      {
        type: "response",
        method: "GET",
        url: "https://a.test/ok",
        status: 200,
        seq: 7,
        id: "7",
        ts: "2024-01-01T00:00:06.000Z",
        sessionId: "s",
      },
    ];

    const summary = summarizeErrors(events);
    expect(summary.total).toBe(6);
    expect(summary.pageErrors).toHaveLength(1);
    expect(summary.pageErrors[0]?.count).toBe(2);
    expect(summary.pageErrors[0]?.firstAt).toBe("2024-01-01T00:00:00.000Z");
    expect(summary.pageErrors[0]?.lastAt).toBe("2024-01-01T00:00:01.000Z");

    expect(summary.consoleErrors).toHaveLength(1);
    expect(summary.consoleErrors[0]?.count).toBe(2);

    expect(summary.networkFailures).toHaveLength(1);
    expect(summary.networkFailures[0]?.count).toBe(2);
    expect(summary.networkFailures[0]?.status).toBe(500);
  });
});

describe("formatEventLine", () => {
  const base = {
    seq: 1,
    id: "1",
    ts: "2024-01-01T00:00:00.000Z",
    sessionId: "s",
  };

  test("renders every event type without throwing, max 300 chars", () => {
    const events: JournalEvent[] = [
      {
        ...base,
        type: "call",
        tool: "act",
        key: "click",
        ok: true,
        durationMs: 42,
        url: "https://example.com",
      },
      {
        ...base,
        type: "console",
        level: "error",
        text: "oops",
        url: "https://example.com",
        line: 10,
      },
      { ...base, type: "pageerror", message: "TypeError: x is not a function" },
      {
        ...base,
        type: "response",
        method: "GET",
        url: "https://example.com",
        status: 404,
        durationMs: 12,
      },
      {
        ...base,
        type: "requestfailed",
        method: "GET",
        url: "https://example.com",
        failure: "net::ERR_FAILED",
      },
      { ...base, type: "navigation", url: "https://example.com" },
      { ...base, type: "crash" },
    ];

    for (const event of events) {
      const line = formatEventLine(event);
      expect(typeof line).toBe("string");
      expect(line.length).toBeLessThanOrEqual(300);
    }

    const call = formatEventLine(events[0] as JournalEvent);
    expect(call).toBe("[call] act:click ok 42ms — https://example.com");

    const crash = formatEventLine(events[6] as JournalEvent);
    expect(crash).toBe("[crash] page crashed");
  });
});

describe("appendCall", () => {
  test("appends a type: call event and returns a callId", async () => {
    const config = makeConfig();
    const callId = await appendCall(config, "sess-call", {
      tool: "observe",
      key: "snapshot",
      durationMs: 5,
      ok: true,
    });
    expect(callId).toMatch(/^call-\d+-\d+$/);
    const { events } = await readJournal(config, "sess-call");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("call");
    expect(events[0]?.callId).toBe(callId);
  });
});
