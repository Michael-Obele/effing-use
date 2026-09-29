---
name: effing-use
description: Drive a headless Chromium browser through 3 token-efficient MCP tools (browser_act, browser_observe, browser_extract). Use when automating web pages, scraping structured data, screenshotting UIs, filling forms, or testing web flows.
license: MIT
compatibility: Requires the effing-use MCP server (Bun + Playwright Chromium). Works over stdio or Streamable HTTP at /mcp.
metadata:
  repo: Michael-Obele/effing-use
  tools: browser_act,browser_observe,browser_extract
---

# effing-use — token-efficient browser control

Three tools cover 100% of the interaction surface at ~4–10x lower token
cost than 21-tool browser servers. `tools/list` is ~3.9KB.

## The loop (always follow this order)

1. `browser_observe` with `kind: "snapshot"` → get `[eN]` refs. Default is `mode: "delta"` (only changes since last observe); use `mode: "full"` for a complete dump. Use `scope: "<css>"` to observe a subtree.
2. `browser_act` to interact (`open`, `click`, `fill`, `type`, `press`, `select`, `check`, `wait`, …). Add `expect: "url~/dashboard"` or `text~/Saved/` for deterministic post-conditions.
3. `browser_observe` with `kind: "snapshot"` again — delta returns `unchanged:true` if nothing changed, or `[changed]` lines.
4. `browser_extract` with `kind: "text" | "table" | "query" | "state"` → scrape or read task state.

Rules:

- Never guess refs. Re-snapshot after every navigation. Stale refs return `E_STALE` or auto-rebind with `rebound:true`.
- Prefer `batch`: one `browser_act` with `steps[]` for fill+press flows (max 20 steps, stops on first error).
- Large outputs are files under `.browser-use/` (gitignored). Read the path, not the preview.
- Snapshots are capped at `OUTPUT_MAX_CHARS` (default 4000) with `…[truncated N chars, see file]`.
- After an uncertain mutation the engine sets `mustObserve:true` — next mutation fails with `E_MUST_OBSERVE` until you observe.

## Tool cheat sheet

**browser_act** — `action` + optional `target` (e-ref, `role=` selector, or CSS) + `value` + `expect` + `approve`:
`open`/`goto` (URL in `value`), `click`, `dblclick`, `fill`, `type`,
`press` (key like `Enter`), `select`, `check`/`uncheck`, `hover`,
`drag` (start in `target`, end in `value`), `upload` (comma-separated paths in `value`),
`scroll` (`up`/`down`/`top`/`bottom` or a target), `back`/`forward`/`reload`,
`wait` (`ms:500`, `text:Saved`, or a ref), `dialog_accept`/`dialog_dismiss` (arm before the triggering step),
`resize` (`1280x800` in `value`), `tab_new`/`tab_select`/`tab_close`, `close`,
`goal` (deterministic add-todo/search planner, else `E_GOAL_UNCLEAR` + `suggestedSteps`),
`batch` (needs `steps[]`), `note` (append to task state), `record_start`/`record_stop` (capture flow), `compile` (macro+SKILL.md), `replay` (deterministic replay, needs `approve:true` for irreversible steps).
`expect` mini-language: `url~<regex>` | `text~<regex>` | `visible=<css>` | `gone=<css>` — evaluated in code, returns `E_EXPECT` or `E_BAD_EXPECT`.

**browser_observe** — read-only: `snapshot` (e-refs, `mode: full|delta` default delta, `scope: <css>`), `screenshot` (file path,
`full` page by default), `url`, `title`, `console` (last N, `limit`),
`network` (method/url/status ring), `tabs`, `focused` (activeElement HTML).

**browser_extract** — `text`, `html`, `table` (≤100 rows as JSON),
`query` (`selector` + `mode: text|href|json`), `pdf` (headless Chromium only),
`trace_start`/`trace_stop` (Playwright trace zip), `state` (task notes + lastActions ring).

Errors always come back as `{ ok: false, code, message, hint }` with codes
`E_NOT_FOUND | E_TIMEOUT | E_NO_PAGE | E_BAD_INPUT | E_GOAL_UNCLEAR | E_STALE | E_EXPECT | E_BAD_EXPECT | E_MUST_OBSERVE | E_APPROVAL_REQUIRED` — never a stack trace.

## CLI face (same engine, no MCP client needed)

```bash
effing-use observe --kind snapshot --mode delta --session dev
effing-use act --action click --target e5 --expect 'url~/dashboard' --session dev
effing-use extract --kind state --session dev
```

Set `EFFING_USE_URL` (default `http://localhost:3123/mcp`). Requires a running `bun src/http.ts` server.

## Record → replay

```bash
# via MCP
browser_act action=record_start value=my-flow
# ... do the flow ...
browser_act action=record_stop
browser_act action=compile value=my-flow   # -> .browser-use/macros/my-flow.{ts,md}
browser_act action=replay value=my-flow    # pauses with E_APPROVAL_REQUIRED if irreversible
browser_act action=replay value=my-flow approve=true
```

## Setup

See [references/setup.md](references/setup.md) for install (local Bun,
Docker, VS Code `mcp.json` entries), port config (`EFFING_PORT`), and the
`.browser-use/` gitignore contract. See [references/troubleshooting.md](references/troubleshooting.md)
for port conflicts, Chromium sandbox notes, and the `doQuery` arity lesson.
