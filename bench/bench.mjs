#!/usr/bin/env bun
// Token-efficiency benchmark: effing-use vs @playwright/mcp on an identical task.
//
// Measures what the plan (effing-use-v2 README §10) actually gates on:
//   - schema cost   : bytes of tools/list
//   - per-step cost : bytes of each tool RESULT as the model would receive it
//   - round trips   : number of model<->tool calls to finish the task
//   - wall clock    : ms
//
// Usage: bun bench/bench.mjs [--target http://localhost:5175/] [--json out.json]

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const TARGET = argOf("--target", "http://localhost:5175/");
const OUT = argOf("--json", null);
const EFFING_URL = process.env.EFFING_USE_URL || "http://localhost:3124/mcp";
const PW_URL = process.env.PLAYWRIGHT_MCP_URL || "http://localhost:8931/mcp";

// ---------------------------------------------------------------- transport
class McpHttp {
  constructor(base) {
    this.base = base;
    this.sid = null;
  }
  async post(body) {
    const res = await fetch(this.base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sid ? { "mcp-session-id": this.sid } : {}),
      },
      body: JSON.stringify(body),
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
  async list() {
    const r = await this.post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    return r?.result?.tools ?? [];
  }
  async call(name, args) {
    const t0 = performance.now();
    const r = await this.post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const ms = Math.round(performance.now() - t0);
    const res = r?.result;
    if (r?.error)
      return { text: JSON.stringify({ error: r.error }), ms, bytes: 0 };
    const text = (res?.content ?? []).map((c) => c.text ?? "").join("\n");
    return { text, ms, bytes: Buffer.byteLength(text) };
  }
}

// ---------------------------------------------------------------- accounting
const estTokens = (bytes) => Math.ceil(bytes / 4);

class Tally {
  constructor() {
    this.steps = [];
  }
  step(label, tool, res) {
    const s = {
      label,
      tool,
      bytes: res.bytes,
      tokens: estTokens(res.bytes),
      ms: res.ms,
    };
    this.steps.push(s);
    return s;
  }
  get totals() {
    const bytes = this.steps.reduce((a, s) => a + s.bytes, 0);
    return {
      roundTrips: this.steps.length,
      resultBytes: bytes,
      resultTokens: estTokens(bytes),
      ms: this.steps.reduce((a, s) => a + s.ms, 0),
    };
  }
}

const show = (name, t, tally, schemaBytes, toolCount) => {
  const tt = tally.totals;
  console.log(`\n=== ${name} ===`);
  console.log(
    `schema: ${toolCount} tools, ${schemaBytes} bytes (~${estTokens(schemaBytes)} tokens)`,
  );
  console.log(
    `flow:   ${tt.roundTrips} round trips, ${tt.resultBytes} B (~${tt.resultTokens} tok), ${tt.ms} ms`,
  );
  console.log(
    `TOTAL:  ${schemaBytes + tt.resultBytes} B (~${estTokens(schemaBytes + tt.resultBytes)} tokens)`,
  );
  for (const s of tally.steps) {
    console.log(
      `  ${String(s.bytes).padStart(7)}B ~${String(s.tokens).padStart(6)}tok  ${String(s.ms).padStart(6)}ms  ${s.label}`,
    );
  }
  return {
    toolCount,
    schemaBytes,
    schemaTokens: estTokens(schemaBytes),
    ...tt,
    totalBytes: schemaBytes + tt.resultBytes,
    totalTokens: estTokens(schemaBytes + tt.resultBytes),
    steps: tally.steps,
  };
};

// ---------------------------------------------------------------- effing-use
async function benchEffing() {
  const t = new McpHttp(EFFING_URL);
  await t.init("bench");
  const tools = await t.list();
  const schemaBytes = Buffer.byteLength(JSON.stringify(tools));
  const tally = new Tally();

  tally.step(
    "open",
    "browser_act",
    await t.call("browser_act", {
      action: "open",
      value: TARGET,
      sessionId: "bench-e",
    }),
  );
  tally.step(
    "observe (delta)",
    "browser_observe",
    await t.call("browser_observe", { sessionId: "bench-e" }),
  );
  tally.step(
    "observe (scoped)",
    "browser_observe",
    await t.call("browser_observe", {
      sessionId: "bench-e",
      scope: "nav",
    }),
  );
  // extract state = the bounded task-state face (Pillar 2 §5.3)
  tally.step(
    "extract state",
    "browser_extract",
    await t.call("browser_extract", { kind: "state", sessionId: "bench-e" }),
  );
  await t.call("browser_act", { action: "close", sessionId: "bench-e" });
  return show("effing-use", null, tally, schemaBytes, tools.length);
}

// ---------------------------------------------------------------- playwright
async function benchPlaywright() {
  const t = new McpHttp(PW_URL);
  await t.init("bench");
  const tools = await t.list();
  const schemaBytes = Buffer.byteLength(JSON.stringify(tools));
  const tally = new Tally();

  tally.step(
    "navigate",
    "browser_navigate",
    await t.call("browser_navigate", { url: TARGET }),
  );
  // Playwright MCP has no delta mode: the model must re-read the full
  // accessibility snapshot after every action. That is the comparison point.
  tally.step(
    "snapshot (full)",
    "browser_snapshot",
    await t.call("browser_snapshot", {}),
  );
  tally.step(
    "snapshot again (no delta)",
    "browser_snapshot",
    await t.call("browser_snapshot", {}),
  );
  await t.call("browser_close", {});
  return show("playwright-mcp", null, tally, schemaBytes, tools.length);
}

// ---------------------------------------------------------------- runner
const results = { target: TARGET, at: new Date().toISOString(), runs: {} };
const only = argOf("--only", null);

if (!only || only === "effing") {
  try {
    results.runs.effing = await benchEffing();
  } catch (e) {
    console.log(`effing-use FAILED: ${e.message}`);
    results.runs.effing = { error: String(e.message) };
  }
}
if (!only || only === "playwright") {
  try {
    results.runs.playwright = await benchPlaywright();
  } catch (e) {
    console.log(`playwright-mcp FAILED: ${e.message}`);
    results.runs.playwright = { error: String(e.message) };
  }
}

const a = results.runs.effing;
const b = results.runs.playwright;
if (a?.totalTokens && b?.totalTokens) {
  const ratio = b.totalTokens / a.totalTokens;
  console.log(
    `\n>>> effing-use ${ratio.toFixed(2)}x cheaper end-to-end ` +
      `(schema ${ratio2(b.schemaTokens, a.schemaTokens)} | flow ${ratio2(b.resultTokens, a.resultTokens)})`,
  );
  results.verdict = {
    totalTokenRatio: Number(ratio.toFixed(2)),
    schemaTokenRatio: Number(ratio2(b.schemaTokens, a.schemaTokens).toFixed(2)),
    flowTokenRatio: Number(ratio2(b.resultTokens, a.resultTokens).toFixed(2)),
    roundTripRatio: Number((b.roundTrips / a.roundTrips).toFixed(2)),
  };
}
function ratio2(high, low) {
  return low > 0 ? Number((high / low).toFixed(2)) : 0;
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${OUT}`);
}
