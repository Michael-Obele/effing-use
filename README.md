# effing-use — stop paying 19.5 KB every session for browser control

[![npm version](https://img.shields.io/npm/v/effing-use)](https://www.npmjs.com/package/effing-use) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE) [![Bun](https://img.shields.io/badge/runtime-Bun%201.4%2B-black?logo=bun)](https://bun.sh)

Full Chromium automation in **3 tools, 3.9 KB**. Same pages, same clicks, same scrapes — without the 24-tool handshake eating your context window before you load a page.

**Measured, not marketed:** `tools/list` is **3,913 bytes** here vs **19,517 bytes** for `@playwright/mcp@latest` (~5x smaller, ~15.6 KB saved every session). Local ops stay in milliseconds — snapshot ~15 ms, extract ~50 ms, batch ~65 ms, screenshot ~60–190 ms. Page loads still cost seconds (network, not us). Full numbers in [`docs/COMPARISON.md`](docs/COMPARISON.md).

## Install (Bun-only)

Requires [Bun](https://bun.sh) 1.4+. Installs from npm in seconds — the tarball is ~16 kB ([`effing-use` v0.1.1](https://www.npmjs.com/package/effing-use)):

```bash
# No install needed — bunx fetches from npm on first run
bunx effing-use               # CLI (needs running server) — effing-use observe/act/extract
bunx effing-use-http          # HTTP MCP on :3123 (/mcp) — shared across editors
bunx effing-use-stdio         # STDIO MCP (single editor) — legacy bin
bunx playwright install chromium --only-shell   # one-time Chromium download (~150 MB)
```

Optional — install globally so `effing-use` is on your PATH:

```bash
bun install -g effing-use
effing-use --help             # CLI
effing-use-http               # HTTP MCP on :3123 (/mcp)
effing-use-stdio              # STDIO MCP
```

The `playwright` npm package ships the driver, **not** the browser — every user needs Playwright's version-pinned Chromium once. From source instead:

```bash
bun install
bunx playwright install chromium --only-shell
bun src/cli.ts --help         # CLI (needs running server)
bun src/http.ts               # HTTP MCP on :3123 (/mcp)
bun src/index.ts              # STDIO MCP
```

Re-run `bunx playwright install chromium --only-shell` whenever you bump the `playwright` dependency (each Playwright version pins its own browser build). Verify with `bunx playwright install --dry-run chromium` or check `~/.cache/ms-playwright/`.

**Why Chromium is separate:** Playwright supports multiple browsers and updates its pinned builds every release, so the binary can't live inside the npm tarball (ours is 16 kB). Docker users skip this — Chromium is baked into the `mcr.microsoft.com/playwright` base image.

## Run it in 60 seconds (recommended path)

**Step 1/3 — Start the server.** One server, every local editor:

```bash
bun install
bunx playwright install chromium --only-shell
docker compose up --build -d
curl http://localhost:3123/healthz
```

Point any VS Code instance at `http://localhost:3123/mcp` (see `.vscode/mcp.json` → `effing-use (http)`). Plain HTTP on loopback is intentional — add TLS at the edge for remote use.

**Step 2/3 — Connect.** STDIO for one editor, HTTP for all of them:

```json
{
  "mcpServers": {
    "effing-use": {
      "command": "bunx",
      "args": ["effing-use-stdio"]
    }
  }
}
```

Or HTTP: `http://localhost:3123/mcp` (via `bunx effing-use-http` or Docker). From source instead: `command: "bun"`, `args: ["/path/to/effing-use/src/index.ts"]`.

**CLI vs MCP — when to use which:**

| Surface         | Command                                 | Needs server?                   | Best for                        |
| --------------- | --------------------------------------- | ------------------------------- | ------------------------------- |
| **MCP (stdio)** | `effing-use-stdio` / `bun src/index.ts` | No (spawns own browser)         | Single VS Code / Claude Desktop |
| **MCP (http)**  | `effing-use-http` / `bun src/http.ts`   | Yes (`:3123`)                   | Shared across editors, Docker   |
| **CLI**         | `effing-use` / `bun src/cli.ts`         | Yes (`:3123`, `EFFING_USE_URL`) | Terminal agents, scripts, CI    |

The CLI is a thin HTTP client over the same engine — `effing-use observe --kind snapshot --mode delta` and `browser_observe kind=snapshot mode=delta` hit the same code. Start the server once (`bun src/http.ts` or `docker compose up`), then use either face.

**Step 3/3 — Drive.** Search Wikipedia in one call instead of two round-trips:

```jsonc
// browser_act batch: fill + press in 65 ms measured
{
  "action": "batch",
  "steps": [
    { "action": "fill", "target": "input[name=search]", "value": "Playwright" },
    { "action": "press", "target": "input[name=search]", "value": "Enter" },
  ],
}
```

No Docker? `bun src/cli.ts --help` (CLI), `bun src/index.ts` (STDIO MCP), or `bun src/http.ts` (`:3123` `/mcp`) works directly.

## Why agents prefer 3 tools

- 🪶 **Tiny handshake, full surface** — `browser_act` (32 actions), `browser_observe` (8 kinds + `mode`/`scope`), `browser_extract` (8 kinds incl. `state`). No schema bloat, no guessing which of 24 tools to call.
- 🧠 **Context-safe by default** — snapshots capped at `OUTPUT_MAX_CHARS` (default 4000); full YAML/text saved under `.browser-use/`, never dumped inline. HN snapshot: 4,034-char preview, full file on disk.
- 🖼️ **File paths, not base64** — screenshots, PDFs, traces return paths like `.browser-use/shot-*.png`. Read the file only when needed.
- ⚡ **One call, not five** — `batch` runs fill+press flows in one turn (max 20 steps, stops on first error). `goal` plans or returns `E_GOAL_UNCLEAR` + `suggestedSteps` instead of hallucinating.
- 🐳 **Shared, not spawned** — one Docker server serves every local VS Code instance. No per-client `npx` spawn.

## The loop (agents: follow this order)

1. `browser_observe` kind=`snapshot` → get `[eN]` refs (default `mode: delta` — only changed lines; `mode: full` for complete dump; `scope: "<css>"` for subtree). Never guess refs, re-snapshot after navigation.
2. `browser_act` to interact — prefer `batch` with `steps[]`; add `expect: "url~/dashboard"` for deterministic post-conditions
3. `browser_observe` kind=`snapshot` again — delta returns `unchanged:true` or `[changed]` lines
4. `browser_extract` kind=`text`|`table`|`query`|`state` → scrape or read task state (`notes` + `lastActions`)

CLI equivalent: `effing-use observe --kind snapshot --mode delta` / `effing-use act --action click --target e5 --expect 'url~/dashboard'` / `effing-use extract --kind state`

## Tools

- `browser_act` — open/goto, click, dblclick, fill, type, press, select, check/uncheck, hover, drag, upload, scroll, back/forward/reload, wait, dialog_accept/dismiss, tabs (new/select/close), resize, close, `goal`, `batch`, `note`, `record_start`/`record_stop`, `compile`, `replay` (+ `expect` + `approve`)
- `browser_observe` — snapshot (e-refs, `mode: full|delta` default delta, `scope`), screenshot (path), url, title, console (last N), network (method/url/status ring), tabs, focused
- `browser_extract` — text, html, table (≤100 rows JSON), query (text|href|json), pdf, trace_start/stop, `state`

Errors are always `{ ok: false, code, message, hint }` with `E_NOT_FOUND | E_TIMEOUT | E_NO_PAGE | E_BAD_INPUT | E_GOAL_UNCLEAR | E_STALE | E_EXPECT | E_BAD_EXPECT | E_MUST_OBSERVE | E_APPROVAL_REQUIRED` — never a stack trace.

## effing-use vs Playwright MCP

|                  | effing-use                      | Playwright MCP                                             |
| ---------------- | ------------------------------- | ---------------------------------------------------------- |
| `tools/list`     | **3,913 bytes / 3 tools**       | **19,517 bytes / 24 tools**                                |
| Snapshot         | capped 4 KB preview + full file | full accessibility tree                                    |
| Screenshots/PDFs | file paths                      | inline or output dir                                       |
| Browsers         | Chromium (headless in Docker)   | Chromium, Firefox, WebKit, Edge + vision/pdf/devtools caps |

Need Firefox/WebKit, device emulation, or persistent profiles? Use Playwright MCP. Need context budget for Chromium work? Stay here. Full breakdown in [`docs/COMPARISON.md`](docs/COMPARISON.md).

## Record → replay

```bash
# MCP
browser_act action=record_start value=my-flow
# ... do the flow ...
browser_act action=record_stop
browser_act action=compile value=my-flow   # -> .browser-use/macros/my-flow.{ts,md}
browser_act action=replay value=my-flow    # pauses with E_APPROVAL_REQUIRED if irreversible
browser_act action=replay value=my-flow approve=true
```

## Config

Env defaults in [`.env.example`](.env.example): `BROWSER_HEADLESS`, `BROWSER_VIEWPORT_W/H`, `BROWSER_TIMEOUT_MS`, `OUTPUT_DIR` (`.browser-use/`, gitignored), `OUTPUT_MAX_CHARS`, `ALLOW_EVAL`, `DELTA_DEFAULT`, `EFFECT_MAX_CHARS`, `STATE_MAX_LINES`, `RECORD_REDACT`, `EFFING_USE_URL`.

Agent skill: `skills/effing-use/SKILL.md` (skills.sh-ready).

## Verify

```bash
bunx tsc --noEmit   # 0 errors
bun test            # 6 pass
```
