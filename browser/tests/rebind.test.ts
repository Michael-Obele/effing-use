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
import { macroLocator } from "../src/browser/refs.js";
import { emptyHint as emptyHintForTest } from "../src/browser/engine.js";
import { rewriteHostHeader } from "../src/browser/bridge.js";
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

  // Regression (2026-09-29): adding a TodoMVC todo inserts two buttons at the
  // TOP of the list, renumbering every later ref by +2. A line diff keyed on
  // the whole line (ref included) then reported every node as changed and
  // every old ref as removed — 83% delta vs the plan's <25% gate (§10.6).
  test("ref renumbering is not a semantic change (plan §10.6)", () => {
    // A realistic-sized snapshot: a long unchanged list plus two prepended
    // nodes, which renumbers every later ref by +2.
    const tail = [
      'a "All"',
      'a "Active"',
      'a "Completed"',
      'button "" aria="Clear completed"',
      'a "React"',
      'a "Quick Start"',
      'a "API Reference"',
      'a "Philosophy"',
      'a "React Community"',
      'a "ReactJS on Stack Overflow"',
      'a "Learn React"',
      'button "" aria="Toggle todo"',
      'input "" aria="new-todo"',
      'a "TodoMVC"',
      'a "Source"',
      'a "Demo"',
      'a "Documentation"',
      'a "Twitter"',
    ];
    const before = tail.map((c, i) => `[e${i}] ${c}`).join("\n");
    const inserted = [
      'input "" aria="Toggle todo"',
      'button "" aria="Delete todo"',
    ];
    const after = [
      `[e0] ${tail[0]}`,
      ...inserted.map((c, i) => `[e${i + 1}] ${c}`),
    ]
      .concat(tail.slice(1).map((c, i) => `[e${i + 3}] ${c}`))
      .join("\n");

    const r = computeDelta(before, after);
    expect(r.unchanged).toBe(false);
    // Only the two genuinely new nodes are reported as changed.
    expect(r.delta).toContain('[changed] [e1] input "" aria="Toggle todo"');
    expect(r.delta).toContain('[changed] [e2] button "" aria="Delete todo"');
    // Shifted-but-identical nodes must NOT be reported as changed.
    expect(r.delta).not.toContain('[changed] [e3] a "All"');
    expect(r.delta).not.toContain('[changed] [e20] a "Twitter"');
    // Nothing was actually removed.
    expect(r.delta).not.toContain("[removed]");
    // And the shift is signalled once, cheaply.
    expect(r.delta).toContain("refs shifted after this");
    // The fix's real invariant: after two prepended nodes, the delta stays a
    // small CONSTANT regardless of how long the unchanged list is (only the
    // "N unchanged nodes" counter grows, by a digit or two). Before the fix
    // this grew linearly — every shifted ref was reported as [changed].
    const longTail = Array.from({ length: 120 }, (_, i) => `a "Link ${i}"`);
    const longAfter = [`[e0] ${longTail[0]}`]
      .concat(inserted.map((c, i) => `[e${i + 1}] ${c}`))
      .concat(longTail.slice(1).map((c, i) => `[e${i + 3}] ${c}`))
      .join("\n");
    const longDelta = computeDelta(
      longTail.map((c, i) => `[e${i}] ${c}`).join("\n"),
      longAfter,
    );
    expect(longDelta.delta.length).toBeLessThan(r.delta.length + 10);
    // Plan §10.6 gate (<25% of full) holds on a realistically-sized page.
    expect(longDelta.delta.length / longAfter.length).toBeLessThan(0.25);
  });

  test("duplicate labels are diffed as a multiset, not deduped by Set", () => {
    const before = '[e0] a "Pricing"\n[e1] a "Pricing"';
    const after = '[e0] a "Pricing"';
    const r = computeDelta(before, after);
    expect(r.unchanged).toBe(false);
    // Exactly one occurrence disappeared, not both.
    expect(r.delta.match(/\[removed\]/g)?.length).toBe(1);
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

describe("macroLocator() — plan §6.2 standalone selectors", () => {
  // Regression (2026-09-29): a click on a nav link recorded `resolvedSelector`
  // as the raw e-ref, so compile emitted `page.locator("e2")` — which cannot
  // run outside a session — and replay re-used the positional e-ref against a
  // fresh page and silently no-op'd (E_EXPECT on a working flow).
  test("role+name selectors compile to a real getByRole call", () => {
    expect(macroLocator('role=link[name="Pricing"]')).toBe(
      'page.getByRole("link", { name: "Pricing", exact: true }).first()',
    );
  });
  test("text= engine selectors pin DOM order with .first()", () => {
    expect(macroLocator('text="Pricing"')).toBe(
      'page.locator("text=\\"Pricing\\"").first()',
    );
  });
  test("CSS selectors pass through unchanged", () => {
    expect(macroLocator('input[aria-label="New Todo Input"]')).toBe(
      'page.locator("input[aria-label=\\"New Todo Input\\"]")',
    );
  });
  test("an unresolved e-ref never becomes a live locator", () => {
    // Must NOT be a locator expression — a bare e-ref throws at runtime.
    const out = macroLocator("e2");
    expect(out).toContain("UNRESOLVED");
    expect(out).not.toContain("page.locator(");
  });
});

describe("macroLocator() snapshot emptiness signal", () => {
  // A canvas/shadow-DOM page yields a snapshot with zero interactive elements.
  // Without a signal the model reads `unchanged:true` and concludes its own
  // action did nothing — a silent failure. Found on a canvas-only test page.
  test("a snapshot with no controls is flagged", () => {
    const out = emptyHintForTest(
      "# Snapshot — refs are nth-match\n# url: x\n(no interactive elements)",
    );
    expect(out.looksEmpty).toBe(true);
    expect(String(out.emptyHint)).toContain("screenshot");
  });

  test("a normal snapshot is not flagged", () => {
    const out = emptyHintForTest(
      '# Snapshot — refs are nth-match\n# url: x\n[e0] a "Home"',
    );
    expect(out.looksEmpty).toBeUndefined();
  });
});

describe("loopback bridge host header rewrite", () => {
  // a Host header that is not localhost, which is why opening
  // host.docker.internal:5175 failed. The bridge splices container loopback to
  // the host and rewrites Host: back to localhost so no vite.config change is
  // needed.
  test("rewrites the Host header to localhost:port", async () => {
    const raw = Buffer.from(
      "GET /pricing HTTP/1.1\r\nHost: 127.0.0.1:5175\r\nAccept: */*\r\n\r\n",
      "latin1",
    );
    const out = rewriteHostHeader(raw, 5175).toString("latin1");
    expect(out).toContain("Host: localhost:5175");
    expect(out).not.toContain("Host: 127.0.0.1:5175");
    // The rest of the request is byte-identical.
    expect(out).toContain("GET /pricing HTTP/1.1");
    expect(out).toContain("Accept: */*");
  });

  test("rewrites a host.docker.internal Host header too", async () => {
    const raw = Buffer.from(
      "GET / HTTP/1.1\r\nHost: host.docker.internal:5175\r\n\r\n",
      "latin1",
    );
    expect(rewriteHostHeader(raw, 5175).toString("latin1")).toContain(
      "Host: localhost:5175",
    );
  });

  test("passes non-HTTP payloads through untouched (TLS/WS handshakes)", () => {
    const tls = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0xff]);
    expect(rewriteHostHeader(tls, 5175)).toBe(tls);
  });

  test("leaves an already-correct Host header idempotent", async () => {
    const raw = Buffer.from(
      "GET / HTTP/1.1\r\nHost: localhost:5175\r\n\r\n",
      "latin1",
    );
    expect(rewriteHostHeader(raw, 5175).toString("latin1")).toBe(
      "GET / HTTP/1.1\r\nHost: localhost:5175\r\n\r\n",
    );
  });
});
