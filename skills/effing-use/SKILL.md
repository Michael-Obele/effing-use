---
name: effing-use
description: Drive a headless Chromium browser through 3 token-efficient MCP tools (browser_act, browser_observe, browser_extract). Use when automating web pages, scraping structured data, screenshotting UIs, filling forms, or testing web flows.
license: MIT
compatibility: Requires the effing-use MCP server (Bun + Playwright Chromium). Works over stdio or Streamable HTTP at /mcp.
metadata:
  repo: Michael-Obele/litepilot
  tools: browser_act,browser_observe,browser_extract
---

# effing-use — token-efficient browser control

Three tools cover 100% of the interaction surface at ~4–10x lower token
cost than 21-tool browser servers. `tools/list` is ~3.9KB.

## The loop (always follow this order)

1. `browser_observe` with `kind: "snapshot"` → get `[eN]` refs.
2. `browser_act` to interact (`open`, `click`, `fill`, `type`, `press`, `select`, `check`, `wait`, …).
3. `browser_observe` with `kind: "screenshot"` → verify visually (returns a file path).
4. `browser_extract` with `kind: "text" | "table" | "query"` → scrape.

Rules:

- Never guess refs. Re-snapshot after every navigation.
- Prefer `batch`: one `browser_act` with `steps[]` for fill+press flows (max 20 steps, stops on first error).
- Large outputs are files under `.browser-use/` (gitignored). Read the path, not the preview.
- Snapshots are capped at `OUTPUT_MAX_CHARS` (default 4000) with `…[truncated N chars, see file]`.

## Tool cheat sheet

**browser_act** — `action` + optional `target` (e-ref, `role=` selector, or CSS) + `value`:
`open`/`goto` (URL in `value`), `click`, `dblclick`, `fill`, `type`,
`press` (key like `Enter`), `select`, `check`/`uncheck`, `hover`,
`drag` (start in `target`, end in `value`), `upload` (comma-separated paths in `value`),
`scroll` (`up`/`down`/`top`/`bottom` or a target), `back`/`forward`/`reload`,
`wait` (`ms:500`, `text:Saved`, or a ref), `dialog_accept`/`dialog_dismiss` (arm before the triggering step),
`resize` (`1280x800` in `value`), `tab_new`/`tab_select`/`tab_close`, `close`,
`goal` (deterministic add-todo/search planner, else `E_GOAL_UNCLEAR` + `suggestedSteps`),
`batch` (needs `steps[]`).

**browser_observe** — read-only: `snapshot` (e-refs), `screenshot` (file path,
`full` page by default), `url`, `title`, `console` (last N, `limit`),
`network` (method/url/status ring), `tabs`, `focused` (activeElement HTML).

**browser_extract** — `text`, `html`, `table` (≤100 rows as JSON),
`query` (`selector` + `mode: text|href|json`), `pdf` (headless Chromium only),
`trace_start`/`trace_stop` (Playwright trace zip).

Errors always come back as `{ ok: false, code, message, hint }` with codes
`E_NOT_FOUND | E_TIMEOUT | E_NO_PAGE | E_BAD_INPUT | E_GOAL_UNCLEAR` — never a stack trace.

## Setup

See [references/setup.md](references/setup.md) for install (local Bun,
Docker, VS Code `mcp.json` entries), port config (`ECU_PORT`), and the
`.browser-use/` gitignore contract. See [references/troubleshooting.md](references/troubleshooting.md)
for port conflicts, Chromium sandbox notes, and the `doQuery` arity lesson.
