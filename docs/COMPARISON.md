# effing-use vs Playwright MCP — measured comparison

Date: 2026-09-05. Measured locally on this repo, headless Chromium, `OUTPUT_MAX_CHARS=4000`.
No estimates below except the token heuristic in §2 (labeled as rough) — every byte and millisecond was captured with the commands in [Reproduce](#reproduce).

## Method

- Weight: pipe `initialize` → `notifications/initialized` → `tools/list` over STDIO, weigh the JSON `tools/list` response in bytes. Re-ran 2026-09-05: **3,913 bytes / 3 tools** (stable across runs).
- Speed: headless Chromium via `doAct`/`doObserve`/`doExtract` against `example.com`, `news.ycombinator.com`, `en.wikipedia.org/wiki/Playwright`. Timed with `performance.now()`.
- Outputs: `OUTPUT_MAX_CHARS=4000` (default). Preview chars measured from `summary`/`preview` fields; full artifacts under `.browser-use/` (gitignored).
- Checks: `bunx tsc --noEmit` → 0 errors; `bun test` → 6 pass.
- Competitor: `@playwright/mcp@latest` via `npx`, same `tools/list` weighing method.

## TL;DR

|                                             | effing-use (this repo)                                  | @playwright/mcp@latest                     |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `tools/list` size                           | **3,913 bytes, 3 tools**                                | **19,517 bytes, 24 tools**                 |
| Ratio                                       | **~5.0x smaller**                                       | baseline                                   |
| Local ops (snapshot / extract / screenshot) | **12–192 ms**                                           | not measured here (network dominates both) |
| Snapshot strategy                           | capped at 4,000 chars + full file under `.browser-use/` | full accessibility tree per response       |
| Setup                                       | `bun install` + Chromium, or `docker compose up`        | `npx @playwright/mcp@latest`               |

## 1. Weight: `tools/list` bytes (what every agent pays on every session)

Measured by piping `initialize` → `notifications/initialized` → `tools/list` over stdio and weighing the JSON response.

| Server          | Tools                                                   | `tools/list` bytes | Per-tool schema bytes             |
| --------------- | ------------------------------------------------------- | ------------------ | --------------------------------- |
| effing-use      | 3 (`browser_act`, `browser_observe`, `browser_extract`) | 3,913              | act 990, observe 354, extract 340 |
| @playwright/mcp | 24 (see list below)                                     | 19,517             | —                                 |

Playwright tool names observed: `browser_close`, `browser_resize`, `browser_console_messages`, `browser_handle_dialog`, `browser_evaluate`, `browser_file_upload`, `browser_drop`, `browser_find`, `browser_fill_form`, `browser_press_key`, `browser_type`, `browser_navigate`, `browser_navigate_back`, `browser_network_requests`, `browser_network_request`, `browser_run_code_unsafe`, `browser_take_screenshot`, `browser_snapshot`, `browser_click`, `browser_drag`, `browser_hover`, `browser_select_option`, `browser_tabs`, `browser_wait_for`.

Why it matters: `tools/list` ships on session start and stays in context. ~15.6 KB saved is room for more page content, more reasoning steps, or a smaller model.

> Note: the old README said "~13.7KB / 21 tools" — stale. Current measurement is **~19.5KB / 24 tools**.

### Rough token translation (heuristic, not a bill)

As a rough heuristic (~4 chars/token for English/JSON), 3,913 bytes ≈ ~1,000 tokens vs 19,517 bytes ≈ ~4,900 tokens. So the handshake alone saves roughly **~3,900 tokens** every session before a single page loads. Actual tokenizer counts vary by model — treat this as direction, not a quote.

## 2. Speed: real sites, headless Chromium

Network dominates both servers. Local ops (the part effing-use controls) are consistently fast:

| Page                             | open                                | snapshot | extract text |
| -------------------------------- | ----------------------------------- | -------- | ------------ |
| example.com                      | 1,107 ms (run 1) / 2,689 ms (run 2) | 14–17 ms | 49–55 ms     |
| news.ycombinator.com             | 2,519 ms / 3,083 ms                 | 12–25 ms | 47 ms        |
| en.wikipedia.org/wiki/Playwright | 4,513 ms                            | 16 ms    | 53 ms        |

| Op                                             | Time                                              |
| ---------------------------------------------- | ------------------------------------------------- |
| `batch` (fill search + press Enter, Wikipedia) | 64–65 ms                                          |
| `screenshot` (full page PNG → file path)       | 60–192 ms                                         |
| `console` / `network` ring read                | < 5 ms (0 console logs, 20 network reqs observed) |

Takeaway: page loads cost seconds (network + site weight); everything after the load — snapshot, extract, batch, screenshot — costs milliseconds.

### Round-trips: why `batch` matters

A Wikipedia search (fill box + press Enter) measured **64–65 ms in one `browser_act` call** with `steps[]`. The same flow as two separate tool calls costs two model→tool→model round-trips plus two response payloads in context. `batch` (max 20 steps, stops on first error) collapses N interactions into 1 call and 1 response — fewer turns, less context burned on tool plumbing.

## 3. Output efficiency: capped previews, file-path-first

`OUTPUT_MAX_CHARS` defaults to 4,000. The agent sees a capped preview; the full artifact lives under `.browser-use/` (gitignored).

| Page                             | Snapshot preview | Truncated?              | Text preview | Truncated?              |
| -------------------------------- | ---------------- | ----------------------- | ------------ | ----------------------- |
| example.com                      | 176 chars        | no                      | 129 chars    | no                      |
| news.ycombinator.com             | 4,034 chars      | yes → full YAML in file | 3,905 chars  | no                      |
| en.wikipedia.org/wiki/Playwright | 4,034 chars      | yes → full YAML in file | 4,035 chars  | yes → full text in file |

Screenshots, PDFs, and traces are never inlined as base64 — the response is a path like `.browser-use/shot-2026-09-05T11-19-21-269Z.png`. The agent reads the file only when it needs to.

## 4. Coverage: 3 tools, same surface

| effing-use tool             | Covers                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_act` (27 actions)  | open/goto, click, dblclick, fill, type, press, select, check/uncheck, hover, drag, upload, scroll, back/forward/reload, wait, dialog_accept/dismiss, close, goal, batch, tab_new/tab_select/tab_close, resize |
| `browser_observe` (8 kinds) | snapshot (e-refs), screenshot (path), url, title, console, network, tabs, focused                                                                                                                             |
| `browser_extract` (7 kinds) | text, html, table (≤100 rows JSON), query (text\|href\|json), pdf, trace_start/stop                                                                                                                           |

Errors are always `{ ok: false, code, message, hint }` with `E_NOT_FOUND | E_TIMEOUT | E_NO_PAGE | E_BAD_INPUT | E_GOAL_UNCLEAR` — never a stack trace.

### Failure modes

| Situation                | effing-use                                          | Notes                                                                              |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bad ref / missing target | `E_NOT_FOUND` + hint to re-snapshot                 | Refs are nth-match (`eN`), never guessed; re-snapshot after navigation             |
| Slow page / selector     | `E_TIMEOUT` (default 15 s via `BROWSER_TIMEOUT_MS`) | Tune per env                                                                       |
| No page / closed session | `E_NO_PAGE`                                         | Session per `sessionId`, default `"default"`                                       |
| Vague `goal`             | `E_GOAL_UNCLEAR` + `suggestedSteps`                 | Deterministic planner, not magic — it tells you the steps instead of hallucinating |
| `batch` with >20 steps   | `E_BAD_INPUT`, page untouched                       | Guard verified by unit test                                                        |

## 5. Setup / ops

|            | effing-use                                                                                                            | Playwright MCP                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Runtime    | Bun + Playwright Chromium (`bunx playwright install chromium --only-shell`)                                           | Node 18+ via `npx @playwright/mcp@latest`                                      |
| Transports | STDIO (`bun src/index.ts`) + Streamable HTTP (`bun src/http.ts` → `/mcp`, `:3000`)                                    | STDIO + `--port` HTTP                                                          |
| Sharing    | `docker compose up --build -d` → any local VS Code instance hits `http://localhost:3000/mcp`                          | per-client `npx` spawn (or `--isolated` / `--user-data-dir` for profiles)      |
| Browsers   | Chromium only (headless in Docker)                                                                                    | Chromium, Firefox, WebKit, Edge channels + `--caps` (vision, pdf, devtools)    |
| Config     | env: `BROWSER_HEADLESS`, `BROWSER_VIEWPORT_W/H`, `BROWSER_TIMEOUT_MS`, `OUTPUT_DIR`, `OUTPUT_MAX_CHARS`, `ALLOW_EVAL` | 30+ CLI flags (`--browser`, `--caps`, `--viewport-size`, `--storage-state`, …) |

## 6. When to choose which

Choose **effing-use** when: context budget matters, you live in Chromium, you want one shared server (Docker + `/mcp`) for every local editor, and you prefer capped previews + file paths over full trees.

Choose **Playwright MCP** when: you need Firefox/WebKit/Edge channels, device emulation, persistent profiles (`--user-data-dir` / `--storage-state`), vision-coordinate tools, or the 30+ flag config surface.

## 7. Honest limitations

- Chromium-only. If you need Firefox/WebKit, device emulation, or vision-coordinate tools, Playwright MCP is the right call.
- Bun-first: `bin` currently points at `src/index.ts` with a Bun shebang. Node-only `npx` users need a build step.
- No persistent profiles yet — sessions are per-`sessionId`, storage state flags don't exist.
- `goal` is a deterministic planner, not magic: unclear goals return `E_GOAL_UNCLEAR` + `suggestedSteps`.
- Playwright MCP local-op speed not measured here — both servers pay the same network cost on page loads; the measured gap is handshake weight and output strategy, not navigation speed.

## 8. npm readiness

`effing-use` is publishable with fixes. Verified 2026-09-05:

- Name `effing-use` returns 404 on npmjs.com — likely available (confirm with `npm view effing-use`).
- Missing: `LICENSE` file + `license` field (skill declares MIT), `repository`, `files`, `engines`, `publishConfig.access`.
- `bin` points at Bun source — either publish Bun-only (`bunx effing-use`, requires Bun + `playwright install chromium`) or add a `dist/` build and point `bin` there for Node `npx` users.
- `node_modules` is ~59 MB (mostly `playwright`) — keep `playwright` as a dependency, document the Chromium install step.
- Publish: `npm login` (2FA or granular token) → `npm publish --dry-run` → `npm publish` (or `bun publish`). CI alternative: trusted publishing.

## 9. FAQ

**Is the 5x claim real?** Yes — weighed locally, same method both sides: 3,913 vs 19,517 bytes. Re-run the two commands in [Reproduce](#reproduce).

**Does smaller handshake mean faster pages?** No. Page loads are network-bound (1–4.5 s measured). The win is context: ~15.6 KB less schema + capped outputs + fewer round-trips via `batch`.

**What does the agent actually see?** A ≤4,000-char preview plus a file path. Example: HN snapshot → 4,034-char preview, full YAML in `.browser-use/snapshot-*.yaml`. Screenshots → path only, never base64.

**What if I need Firefox?** Use Playwright MCP. This server is Chromium-only by design.

## Reproduce

```bash
# effing-use tools/list weight (3,913 bytes, 3 tools)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bench","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| bun src/index.ts

# Playwright MCP tools/list weight (19,517 bytes, 24 tools)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bench","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| npx -y @playwright/mcp@latest

# Speed + output sizes (headless Chromium, real sites)
bun test && bunx tsc --noEmit
```

Unit suite: `bun test` (cap/truncate, batch guard, goal planner). Typecheck: `bunx tsc --noEmit` (0 errors).
