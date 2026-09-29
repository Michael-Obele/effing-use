import { describe, expect, test } from "bun:test";
import {
  chooseRebindIndex,
  looseMatch,
  fuzzyMatch,
  type Fingerprint,
  type RebindCandidate,
} from "../src/browser/identity.js";
import { computeDelta } from "../src/browser/delta.js";
import { parseExpect } from "../src/browser/evidence.js";
import { isIrreversible } from "../src/browser/macro.js";
import {
  getReplayCursor,
  setReplayCursor,
  clearReplayCursor,
} from "../src/browser/record.js";

const fp = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  role: "generic",
  accessibleName: "",
  textHash: "",
  box: { x: 0, y: 0, w: 0, h: 0 },
  pathHash: "",
  ...over,
});

const cand = (index: number, over: Partial<Fingerprint>): RebindCandidate => ({
  index,
  fp: fp(over),
});

/**
 * Seeded re-render suite (plan tasks.md §1.4). The core invariant: a stale ref
 * either rebinds to the element the model MEANT, or returns null (→ E_STALE,
 * no click) — it must never pick a different element.
 */
describe("chooseRebindIndex() — seeded re-render suite", () => {
  // The exact live regression: stale TodoMVC item toggle (after a list shift)
  // must rebind to THAT item's checkbox, never to toggle-all or another row.
  test("TodoMVC list shift: stale item toggle binds to its own row", () => {
    const expected = fp({
      role: "checkbox",
      textHash: "third",
      pathHash: "html>body>div>main>ul>li>div>input",
    });
    const candidates = [
      cand(11, {
        role: "checkbox",
        textHash: "",
        pathHash: "html>body>div>main>span>input",
      }), // toggle-all
      cand(12, {
        role: "checkbox",
        textHash: "first",
        pathHash: "html>body>div>main>ul>li>div>input",
      }),
      cand(14, {
        role: "checkbox",
        textHash: "second",
        pathHash: "html>body>div>main>ul>li>div>input",
      }),
      cand(16, {
        role: "checkbox",
        textHash: "third",
        pathHash: "html>body>div>main>ul>li>div>input",
      }), // ← target
      cand(18, { role: "link", accessibleName: "All", textHash: "All" }),
    ];
    expect(chooseRebindIndex(expected, candidates)).toBe(16);
  });

  test("reordered list: same identity at a new index rebinds there", () => {
    const expected = fp({ role: "link", accessibleName: "Privacy" });
    const candidates = [
      cand(3, { role: "link", accessibleName: "Privacy" }),
      cand(9, { role: "link", accessibleName: "Questions" }),
    ];
    expect(chooseRebindIndex(expected, candidates)).toBe(3);
  });

  test("replaced/renamed button: fuzzy contains-match rebinds", () => {
    const expected = fp({ role: "button", accessibleName: "Save" });
    const candidates = [
      cand(4, { role: "button", accessibleName: "Save changes" }),
      cand(7, { role: "button", accessibleName: "Cancel" }),
    ];
    expect(chooseRebindIndex(expected, candidates)).toBe(4);
  });

  test("renamed label with no overlap → null (E_STALE, never a guess)", () => {
    const expected = fp({ role: "button", accessibleName: "Publish draft" });
    const candidates = [
      cand(4, { role: "button", accessibleName: "Archive" }),
      cand(7, { role: "link", accessibleName: "Publish draft" }), // role mismatch
    ];
    expect(chooseRebindIndex(expected, candidates)).toBeNull();
  });

  test("two identical siblings (same path) → null, not first-match", () => {
    const expected = fp({
      role: "button",
      accessibleName: "",
      textHash: "Delete",
      pathHash: "html>body>div>ul>li>div>button",
    });
    const candidates = [
      cand(5, {
        role: "button",
        accessibleName: "",
        textHash: "Delete",
        pathHash: "html>body>div>ul>li>div>button",
      }),
      cand(9, {
        role: "button",
        accessibleName: "",
        textHash: "Delete",
        pathHash: "html>body>div>ul>li>div>button",
      }),
    ];
    expect(chooseRebindIndex(expected, candidates)).toBeNull();
  });

  test("multiple loose matches narrowed to one by pathHash", () => {
    const expected = fp({
      role: "input",
      textHash: "",
      pathHash: "html>body>form>input",
    });
    const candidates = [
      cand(2, { role: "input", textHash: "", pathHash: "html>body>nav>input" }),
      cand(6, {
        role: "input",
        textHash: "",
        pathHash: "html>body>form>input",
      }),
    ];
    expect(chooseRebindIndex(expected, candidates)).toBe(6);
  });

  test("empty scene → null", () => {
    expect(chooseRebindIndex(fp({ role: "button" }), [])).toBeNull();
  });

  test("ambiguous fuzzy matches → null", () => {
    const expected = fp({ role: "button", accessibleName: "Save" });
    const candidates = [
      cand(1, { role: "button", accessibleName: "Save draft" }),
      cand(2, { role: "button", accessibleName: "Save and exit" }),
    ];
    expect(chooseRebindIndex(expected, candidates)).toBeNull();
  });

  test("matchers: empty names never fuzzy-match each other", () => {
    const a = fp({ role: "button", accessibleName: "", textHash: "" });
    const b = fp({ role: "button", accessibleName: "", textHash: "" });
    expect(looseMatch(a, b)).toBe(true);
    expect(fuzzyMatch(a, b)).toBe(false);
  });
});

describe("computeDelta()", () => {
  test("emits removed lines explicitly (plan §5.1)", () => {
    const baseline = "# h\nline-a\nline-b";
    const current = "# h\nline-a\nline-new";
    const r = computeDelta(baseline, current);
    expect(r.unchanged).toBe(false);
    expect(r.delta).toContain("[changed] line-new");
    expect(r.delta).toContain("[removed] line-b");
  });

  test("identical input is unchanged", () => {
    const r = computeDelta("a\nb", "a\nb");
    expect(r.unchanged).toBe(true);
    expect(r.delta).toBe("");
  });

  test("additions-only delta carries no removed markers", () => {
    const r = computeDelta("a", "a\nb");
    expect(r.delta).toContain("[changed] b");
    expect(r.delta).not.toContain("[removed]");
  });
});

describe("parseExpect()", () => {
  test("accepts the four documented forms", () => {
    expect(parseExpect("url~/dash")).toEqual({ kind: "url", pattern: "/dash" });
    expect(parseExpect("text~hello")).toEqual({
      kind: "text",
      pattern: "hello",
    });
    expect(parseExpect("visible=.modal")).toEqual({
      kind: "visible",
      pattern: ".modal",
    });
    expect(parseExpect("gone=.toast")).toEqual({
      kind: "gone",
      pattern: ".toast",
    });
  });

  test("rejects unknown form and invalid regex", () => {
    expect(parseExpect("bogus-syntax")).toBeNull();
    expect(parseExpect("url~[unclosed")).toBeNull();
  });
});

describe("isIrreversible()", () => {
  test("verb in target trips the gate", () => {
    expect(
      isIrreversible({
        seq: 1,
        op: "click",
        target: 'role=button[name="Delete all notes"]',
      }),
    ).toBe(true);
  });
  test("benign ref click does not", () => {
    expect(isIrreversible({ seq: 0, op: "click", target: "e17" })).toBe(false);
  });
  test("verb in goal text trips the gate", () => {
    expect(
      isIrreversible({ seq: 0, op: "goal", value: "submit the form" }),
    ).toBe(true);
  });
});

describe("replay cursor", () => {
  test("set → get → clear", () => {
    setReplayCursor("s1", "macro", 3);
    expect(getReplayCursor("s1", "macro")).toBe(3);
    expect(getReplayCursor("s1", "other")).toBeUndefined();
    clearReplayCursor("s1", "macro");
    expect(getReplayCursor("s1", "macro")).toBeUndefined();
  });
});
