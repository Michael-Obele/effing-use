#!/usr/bin/env bun
/**
 * Live-site stress benchmark: effing-use vs @playwright/mcp on REAL websites.
 *
 * This is the adversarial version of bench/bench.mjs. Where the first bench ran
 * a clean local SPA, this one deliberately attacks the places effing-use is
 * most likely to LOSE:
 *
 *   - heavy, real DOM (news, docs, encyclopaedia)
 *   - interactive flows (search, forms, filters)
 *   - sites that never settle (live tickers, animations)
 *   - pages with hundreds of interactive elements
 *
 * For each site it records, per tool:
 *   - bytes/tokens of every tool result (what the model actually receives)
 *   - round trips and wall clock
 *   - whether the action produced the intended outcome (correctness)
 *
 * Honest reporting: the ratio is computed from MEASURED payload bytes, and
 * correctness is verified by reading back page state, not by assuming a click
 * that returned 200 actually did anything.
 *
 * Usage:
 *   bun bench/live-bench.mjs
 *   bun bench/live-bench.mjs --sites wikipedia.org,news.ycombinator
 *   bun bench/live-bench.mjs --json /tmp/live.json
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where @playwright/mcp writes its snapshot files. It returns a ~220-byte
 * stub containing only a path, so a benchmark that only counts the inline
 * payload understates its real context cost by 50-200x: the model has to
 * read that file to learn what is on the page. We resolve the path and add
 * the file's size, which is the number that actually hits the context window.
 */
const PW_OUT_DIR = join(process.cwd(), ".playwright-mcp");
let pwOutDir = PW_OUT_DIR;
if (!existsSync(pwOutDir)) {
  const alt = join(process.env.HOME ?? "", ".playwright-mcp");
  if (existsSync(alt)) pwOutDir = alt;
}

/** Sum the sizes of every snapshot file a Playwright result points at. */
function pwFileBytes(text) {
  const paths = [...text.matchAll(/\.playwright-mcp\/([\w.-]+\.yml)/g)].map(
    (m) => m[1],
  );
  let total = 0;
  for (const f of new Set(paths)) {
    const p = join(pwOutDir, f);
    try {
      if (existsSync(p)) total += readFileSync(p).length;
    } catch {}
  }
  return total;
}

// ------------------------------------------------------------------ config
const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const EFFING = process.env.EFFING_USE_URL || "http://localhost:3123/mcp";
const PW = process.env.PLAYWRIGHT_MCP_URL || "http://localhost:8931/mcp";
const OUT = argOf("--json", null);

/**
 * Each site: a name, url, and a flow of steps. `check` reads back page state
 * so we score correctness rather than assuming success.
 */
const SITES = [
  {
    name: "wikipedia (dense text, huge DOM)",
    url: "https://en.wikipedia.org/wiki/Browser_automation",
    steps: [{ tool: "observe" }],
    check: { kind: "text" },
  },
  {
    name: "news.ycombinator (many small links)",
    url: "https://news.ycombinator.com/",
    steps: [{ tool: "observe" }, { tool: "observe" }],
    check: { kind: "text" },
  },
  {
    name: "example.com (minimal baseline)",
    url: "https://example.com/",
    steps: [{ tool: "observe" }],
    check: { kind: "text" },
  },
  {
    name: "todomvc (interactive: fill + press + observe)",
    url: "https://todomvc.com/examples/react/dist/",
    steps: [
      {
        tool: "act",
        action: "fill",
        target: "input.new-todo",
        value: "live bench",
      },
      { tool: "act", action: "press", value: "Enter" },
      { tool: "observe" },
    ],
    check: { kind: "text", mustInclude: "live bench" },
  },
  {
    name: "duckduckgo (form fill, heavier page)",
    url: "https://duckduckgo.com/",
    steps: [
      {
        tool: "act",
        action: "fill",
        target: "#search_form_input",
        value: "playwright mcp",
      },
      { tool: "observe" },
    ],
    check: { kind: "text" },
  },
  {
    name: "react.dev (nav-heavy docs)",
    url: "https://react.dev/learn",
    steps: [{ tool: "observe" }],
    check: { kind: "text" },
  },
  {
    name: "httpbin forms (plain HTML form)",
    url: "https://httpbin.org/forms/post",
    steps: [{ tool: "observe" }],
    check: { kind: "text" },
  },
  {
    name: "github issues list (very dense interactive)",
    url: "https://github.com/microsoft/playwright-mcp/issues",
    steps: [{ tool: "observe" }],
    check: { kind: "text" },
  },
];

const only = argOf("--sites", null);
const SITES_TO_RUN = only
  ? SITES.filter((s) => only.split(",").some((d) => s.url.includes(d)))
  : SITES;

// ---------------------------------------------------------------- transport
const tok = (bytes) => Math.ceil(bytes / 4);

class Mcp {
  constructor(base) {
    this.base = base;
    this.sid = null;
  }
  async post(body, timeoutMs = 45000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.base, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.sid ? { "mcp-session-id": this.sid } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      this.sid = res.headers.get("mcp-session-id") || this.sid;
      const text = await res.text();
      let data = null;
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            data = JSON.parse(line.slice(6));
          } catch {}
        }
      }
      if (!data && text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {}
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }
  async init(name) {
    await this.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name, version: "0" },
      },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async call(name, args, timeoutMs) {
    const t0 = performance.now();
    let r;
    try {
      r = await this.post(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name, arguments: args },
        },
        timeoutMs,
      );
    } catch (e) {
      return {
        text: `{"transportError":"${String(e.message).slice(0, 120)}"}`,
        ms: Math.round(performance.now() - t0),
        bytes: 0,
        error: true,
      };
    }
    const ms = Math.round(performance.now() - t0);
    if (r?.error)
      return {
        text: `{"rpcError":${JSON.stringify(r.error)}}`,
        ms,
        bytes: 0,
        error: true,
      };
    const text = (r?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return { text, ms, bytes: Buffer.byteLength(text), error: false };
  }
}

// ------------------------------------------------------------------ runners
async function runEffing(site) {
  const m = new Mcp(EFFING);
  await m.init("live-effing");
  const steps = [];
  const sid = "live";

  const open = await m.call(
    "browser_act",
    { action: "open", value: site.url, sessionId: sid },
    60000,
  );
  steps.push({ label: "open", ...open });

  for (const s of site.steps) {
    if (s.tool === "observe") {
      const r = await m.call("browser_observe", {
        kind: "snapshot",
        sessionId: sid,
      });
      steps.push({ label: "observe", ...r });
    } else {
      const r = await m.call("browser_act", {
        action: s.action,
        target: s.target,
        value: s.value,
        sessionId: sid,
      });
      steps.push({ label: `${s.action}`, ...r });
    }
  }

  const chk = await m.call("browser_extract", { kind: "text", sessionId: sid });
  await m.call("browser_act", { action: "close", sessionId: sid });
  return finish(site, steps, chk, { countFiles: false });
}

async function runPlaywright(site) {
  const m = new Mcp(PW);
  await m.init("live-pw");
  const steps = [];

  const nav = await m.call("browser_navigate", { url: site.url }, 60000);
  steps.push({ label: "navigate", ...nav });

  for (const s of site.steps) {
    if (s.tool === "observe") {
      const r = await m.call("browser_snapshot", {});
      steps.push({ label: "snapshot", ...r });
    } else {
      const r = await m.call("browser_type", {
        element: s.target,
        text: s.value,
      });
      steps.push({ label: `type`, ...r });
    }
  }

  const chk = await m.call("browser_snapshot", {});
  return finish(site, steps, chk, { countFiles: true });
}

function finish(site, steps, checkRes, opts = {}) {
  // Playwright hides its snapshot in a file; count it, because the model must
  // read that file for the payload to be of any use.
  const pwFileTotal = opts.countFiles
    ? steps.reduce((a, s) => a + pwFileBytes(s.text), 0) +
      pwFileBytes(checkRes.text)
    : 0;
  const inlineBytes = steps.reduce((a, s) => a + s.bytes, 0);
  const bytes = inlineBytes + pwFileTotal;
  const ms = steps.reduce((a, s) => a + s.ms, 0);
  const bad = steps.filter(
    (s) => s.error || /"ok":false|### Error/.test(s.text),
  );
  const includes =
    site.check?.mustInclude && checkRes.text.includes(site.check.mustInclude);
  const passed = bad.length === 0 && checkRes.bytes > 0;
  return {
    site: site.name,
    url: site.url,
    steps: steps.length,
    bytes,
    inlineBytes,
    fileBytes: pwFileTotal,
    tokens: tok(bytes),
    ms,
    passed,
    markerSeen: includes === undefined ? null : includes,
    hadError: bad.length ? bad[0].text.slice(0, 160) : null,
    detail: steps.map((s) => ({
      label: s.label,
      inline: s.bytes,
      file: opts.countFiles ? pwFileBytes(s.text) : 0,
      tokens: tok(s.bytes + (opts.countFiles ? pwFileBytes(s.text) : 0)),
      ms: s.ms,
    })),
  };
}

// ------------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log("LIVE-SITE STRESS BENCHMARK — effing-use vs @playwright/mcp");
console.log(`effing:    ${EFFING}`);
console.log(`playwright: ${PW}\n`);
console.log(
  pad("site", 40) +
    num("eff tok", 10) +
    num("pw inl", 9) +
    num("pw +file", 10) +
    num("ratio", 8) +
    num("eff ms", 9) +
    num("pw ms", 9) +
    "   result",
);
console.log("-".repeat(108));

const results = { at: new Date().toISOString(), sites: [] };
let te = 0,
  tp = 0,
  tpInline = 0,
  me = 0,
  mp = 0,
  wins = 0,
  losses = 0,
  ties = 0;

for (const site of SITES_TO_RUN) {
  const e = await runEffing(site).catch((err) => ({
    site: site.name,
    error: String(err.message),
  }));
  const p = await runPlaywright(site).catch((err) => ({
    site: site.name,
    error: String(err.message),
  }));
  results.sites.push({ site: site.name, effing: e, playwright: p });

  if (e.error || p.error) {
    console.log(
      pad(site.name, 40) + `  ERROR ${e.error || ""} ${p.error || ""}`,
    );
    continue;
  }
  te += e.tokens;
  tp += p.tokens;
  tpInline += tok(p.inlineBytes);
  me += e.ms;
  mp += p.ms;
  const ratio = p.tokens / Math.max(1, e.tokens);
  if (ratio > 1.05) wins++;
  else if (ratio < 0.95) losses++;
  else ties++;
  console.log(
    pad(site.name, 40) +
      num(e.tokens, 10) +
      num(tok(p.inlineBytes), 9) +
      num(p.tokens, 10) +
      num(ratio.toFixed(2) + "x", 8) +
      num(e.ms, 9) +
      num(p.ms, 9) +
      (e.passed ? "  E ok" : "  E FAIL") +
      (p.passed ? " / P ok" : " / P FAIL"),
  );
  if (e.markerSeen === false)
    console.log(`    ! marker not found in effing output`);
  if (p.markerSeen === false)
    console.log(`    ! marker not found in playwright output`);
  if (e.hadError) console.log(`    effing:    ${e.hadError}`);
  if (p.hadError) console.log(`    playwright: ${p.hadError}`);
}

console.log("-".repeat(100));
console.log(
  pad("TOTAL", 40) +
    num(te, 10) +
    num(tpInline, 9) +
    num(tp, 10) +
    num((tp / Math.max(1, te)).toFixed(2) + "x", 8) +
    num(me, 9) +
    num(mp, 9),
);
console.log(
  `\neffing cheaper on ${wins} site(s); playwright cheaper on ${losses}; tie ${ties}.`,
);
console.log(
  `Wall clock (playwright/effing): ${(mp / Math.max(1, me)).toFixed(2)}x`,
);
console.log(
  "NOTE: token ratio counts bytes RETURNED to the model, not reasoning cost.",
);

results.summary = {
  effingTokens: te,
  playwrightTokens: tp,
  playwrightInlineTokens: tpInline,
  wins,
  losses,
  ties,
  effingMs: me,
  playwrightMs: mp,
};
if (OUT) {
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT}`);
}
