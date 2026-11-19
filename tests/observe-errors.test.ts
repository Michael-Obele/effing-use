import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { appendEvent, readJournal } from "../src/browser/journal.js";
import { doExtract, doObserve } from "../src/browser/engine.js";

let outputDir: string;

function makeConfig(outputDir: string): Config {
  return {
    outputDir,
    journal: true,
    journalMaxBytes: 2_000_000,
    recordRedact: true,
  } as Config;
}

async function seed(config: Config): Promise<void> {
  await appendEvent(config, "s", {
    type: "console",
    level: "error",
    text: "boom",
    url: "https://example.com/",
    ts: "2024-01-01T00:00:00.000Z",
  });
  await appendEvent(config, "s", {
    type: "console",
    level: "error",
    text: "boom",
    url: "https://example.com/",
    ts: "2024-01-01T00:00:01.000Z",
  });
  await appendEvent(config, "s", {
    type: "pageerror",
    message: "TypeError: x is not a function",
    name: "TypeError",
    ts: "2024-01-01T00:00:02.000Z",
  });
  await appendEvent(config, "s", {
    type: "response",
    method: "GET",
    url: "https://example.com/api/users",
    status: 500,
    ts: "2024-01-01T00:00:03.000Z",
  });
  await appendEvent(config, "s", {
    type: "requestfailed",
    method: "GET",
    url: "https://example.com/api/upload",
    failure: "net::ERR_FAILED",
    ts: "2024-01-01T00:00:04.000Z",
  });
  await appendEvent(config, "s", {
    type: "console",
    level: "log",
    text: "hello",
    url: "https://example.com/",
    ts: "2024-01-01T00:00:05.000Z",
  });
  await appendEvent(config, "s", {
    type: "response",
    method: "GET",
    url: "https://example.com/home",
    status: 200,
    ts: "2024-01-01T00:00:06.000Z",
  });
}

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "effing-observe-"));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe("doObserve kind=errors", () => {
  test("dedupes errors and reports journal path + total events", async () => {
    const config = makeConfig(outputDir);
    await seed(config);
    const result = await doObserve(
      {} as never,
      config,
      "errors",
      undefined,
      undefined,
      {
        sessionId: "s",
      },
    );
    const r = result as {
      total: number;
      totalEvents: number;
      journal: string;
      consoleErrors: Array<{ count: number }>;
      pageErrors: Array<{ count: number }>;
      networkFailures: Array<{ count: number; status: number }>;
    };
    expect(r.totalEvents).toBe(7);
    expect(r.journal.endsWith("journal.jsonl")).toBe(true);
    expect(r.consoleErrors).toHaveLength(1);
    expect(r.consoleErrors[0]?.count).toBe(2);
    expect(r.pageErrors).toHaveLength(1);
    expect(r.pageErrors[0]?.count).toBe(1);
    expect(r.networkFailures).toHaveLength(2);
    expect(r.total).toBe(5);
  });
});

describe("doObserve kind=console", () => {
  test("filters by level and keeps logs key", async () => {
    const config = makeConfig(outputDir);
    await seed(config);
    const result = await doObserve(
      {} as never,
      config,
      "console",
      undefined,
      undefined,
      {
        sessionId: "s",
        level: "error",
      },
    );
    const r = result as {
      logs: Array<{ type: string }>;
      total: number;
      path: string;
      truncated: boolean;
    };
    expect(r.logs).toHaveLength(2);
    expect(r.logs.every((l) => l.type === "error")).toBe(true);
    expect(r.total).toBe(2);
    expect(r.path.endsWith("journal.jsonl")).toBe(true);
    expect(r.truncated).toBe(false);
  });
});

describe("doObserve kind=network", () => {
  test("filters by substring and keeps requests key", async () => {
    const config = makeConfig(outputDir);
    await seed(config);
    const result = await doObserve(
      {} as never,
      config,
      "network",
      undefined,
      undefined,
      {
        sessionId: "s",
        filter: "api",
      },
    );
    const r = result as {
      requests: Array<{ status: number }>;
      total: number;
      path: string;
      truncated: boolean;
    };
    expect(r.requests).toHaveLength(2);
    expect(r.requests.some((q) => q.status === 500)).toBe(true);
    expect(r.requests.some((q) => q.status === 0)).toBe(true);
    expect(r.total).toBe(2);
    expect(r.path.endsWith("journal.jsonl")).toBe(true);
    expect(r.truncated).toBe(false);
  });
});

describe("journal read consistency", () => {
  test("drains pending fire-and-forget appends before reading", async () => {
    const config = makeConfig(outputDir);
    void appendEvent(config, "pending", {
      type: "console",
      level: "error",
      text: "late",
    });
    const { events } = await readJournal(config, "pending");
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("late");
  });

  test("applies since and pagination to console reads", async () => {
    const config = makeConfig(outputDir);
    await seed(config);
    const recent = await doObserve(
      {} as never,
      config,
      "console",
      undefined,
      1,
      {
        sessionId: "s",
        since: "2024-01-01T00:00:00.500Z",
        level: "error",
      },
    );
    const r = recent as { logs: unknown[]; total: number; truncated: boolean };
    expect(r.total).toBe(1);
    expect(r.logs).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });
});

describe("doExtract kind=timeline", () => {
  test("renders formatted event lines", async () => {
    const config = makeConfig(outputDir);
    await seed(config);
    const result = await doExtract(
      {} as never,
      config,
      "timeline",
      undefined,
      10,
      {
        sessionId: "s",
      },
    );
    const r = result as {
      lines: string[];
      count: number;
      path: string;
      truncated: boolean;
    };
    expect(r.count).toBe(7);
    expect(r.path.endsWith("journal.jsonl")).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.lines.some((l) => l.includes("[console:error]"))).toBe(true);
    expect(r.lines.some((l) => l.includes("[pageerror]"))).toBe(true);
    expect(r.lines.some((l) => l.includes("[net]"))).toBe(true);
  });

  test("honors offset/limit and reports truncated", async () => {
    const config = makeConfig(outputDir);
    await seed(config);
    const result = await doExtract(
      {} as never,
      config,
      "timeline",
      undefined,
      2,
      { sessionId: "s", offset: 1 },
    );
    const r = result as {
      lines: string[];
      count: number;
      truncated: boolean;
    };
    expect(r.count).toBe(7);
    expect(r.lines).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});
