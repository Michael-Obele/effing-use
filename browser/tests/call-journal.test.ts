import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { readJournal } from "../src/browser/journal.js";
import { actTool } from "../src/tools/act.js";
import { observeTool } from "../src/tools/observe.js";
import { extractTool } from "../src/tools/extract.js";

// These tests drive the tool handlers directly. They exercise the journaling
// shell (env config -> run -> appendCall -> error envelope) without launching a
// browser: the cheap, pre-browser error paths still produce a `call` record.

let outputDir: string;
let prevOutputDir: string | undefined;
let prevHeadless: string | undefined;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "effing-call-journal-"));
  prevOutputDir = process.env.OUTPUT_DIR;
  prevHeadless = process.env.BROWSER_HEADLESS;
  process.env.OUTPUT_DIR = outputDir;
  // Keep any accidental page launch from opening a real window.
  process.env.BROWSER_HEADLESS = "true";
});

afterEach(async () => {
  if (prevOutputDir === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = prevOutputDir;
  if (prevHeadless === undefined) delete process.env.BROWSER_HEADLESS;
  else process.env.BROWSER_HEADLESS = prevHeadless;
  await rm(outputDir, { recursive: true, force: true });
});

type CallEvent = {
  type: string;
  tool: string;
  key: string;
  durationMs: number;
  ok: boolean;
  code?: string;
};

// defineTool's execute returns the MCP envelope; unwrap the JSON text payload.
function unwrap(res: unknown): Record<string, unknown> {
  const text =
    (res as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text);
}

async function callEvents(sessionId: string): Promise<CallEvent[]> {
  const config = loadConfig();
  const { events } = await readJournal(config, sessionId);
  return events.filter((e) => e.type === "call") as unknown as CallEvent[];
}

describe("call journaling (browser_act)", () => {
  test("a failing act appends one ok:false call record and returns a journal path", async () => {
    const res = await actTool.execute(
      { action: "batch", steps: [], sessionId: "call-act" },
      {} as never,
    );
    const parsed = unwrap(res);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("E_BAD_INPUT");
    expect(typeof parsed.journal).toBe("string");
    expect(String(parsed.journal).endsWith("journal.jsonl")).toBe(true);

    const calls = await callEvents("call-act");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("act");
    expect(calls[0]?.key).toBe("batch");
    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.code).toBe("E_BAD_INPUT");
    expect(typeof calls[0]?.durationMs).toBe("number");
  });
});

describe("call journaling (browser_extract)", () => {
  test("a failing query (missing selector) appends one ok:false call record", async () => {
    const res = await extractTool.execute(
      { kind: "query", sessionId: "call-extract" },
      {} as never,
    );
    const parsed = unwrap(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("E_BAD_INPUT");
    expect(String(parsed.journal).endsWith("journal.jsonl")).toBe(true);

    const calls = await callEvents("call-extract");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("extract");
    expect(calls[0]?.key).toBe("query");
    expect(calls[0]?.ok).toBe(false);
  });
});

describe("call journaling (browser_observe)", () => {
  test("an unknown kind returns ok:false with a journal path", async () => {
    const res = await observeTool.execute(
      { kind: "definitely-not-a-kind", sessionId: "call-observe" },
      {} as never,
    );
    const parsed = unwrap(res);
    expect(parsed.ok).toBe(false);
    expect(String(parsed.journal).endsWith("journal.jsonl")).toBe(true);

    const calls = await callEvents("call-observe");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("observe");
    expect(calls[0]?.key).toBe("definitely-not-a-kind");
    expect(calls[0]?.ok).toBe(false);
  });
});
