import { describe, expect, test } from "bun:test";
import { cap, stamp } from "../src/browser/output.js";
import { doBatch, doGoal } from "../src/browser/engine.js";
import { EngineError } from "../src/browser/refs.js";
import { ACT_ACTIONS } from "../src/tools/act.js";

describe("cap()", () => {
  test("passes through short text", () => {
    const r = cap("hello", 4000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("hello");
  });
  test("truncates at maxChars with file hint", () => {
    const r = cap("x".repeat(5000), 4000);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("…[truncated 1000 chars, see file]");
    expect(r.text.length).toBeLessThan(5000);
  });
});

describe("stamp()", () => {
  test("builds prefixed filename", () => {
    const s = stamp("snapshot", "yaml");
    expect(s.startsWith("snapshot-")).toBe(true);
    expect(s.endsWith(".yaml")).toBe(true);
  });
});

describe("tool surface", () => {
  test("exactly 27 act actions", () => {
    expect(ACT_ACTIONS.length).toBe(27);
  });
});

describe("doBatch()", () => {
  test("rejects >20 steps without touching the page", async () => {
    const fakePage = {} as never;
    const fakeConfig = {} as never;
    const steps = Array.from({ length: 21 }, () => ({ action: "wait" as const }));
    let err: unknown;
    try {
      await doBatch(fakePage, fakeConfig, steps);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("E_BAD_INPUT");
  });
});

describe("doGoal()", () => {
  test("unclear goal throws E_GOAL_UNCLEAR with suggestedSteps", async () => {
    const fakePage = {} as never;
    const fakeConfig = { timeoutMs: 1000 } as never;
    let err: unknown;
    try {
      await doGoal(fakePage, fakeConfig, "become sentient and file taxes");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    const ee = err as EngineError;
    expect(ee.code).toBe("E_GOAL_UNCLEAR");
    expect(Array.isArray((ee.data as { suggestedSteps?: unknown[] })?.suggestedSteps)).toBe(true);
  });
});
