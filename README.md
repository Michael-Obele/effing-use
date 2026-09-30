# effing-use — stop paying 20 KB every session for browser control

[![npm version](https://img.shields.io/npm/v/effing-use)](https://www.npmjs.com/package/effing-use) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE) [![Bun](https://img.shields.io/badge/runtime-Bun%201.4%2B-black?logo=bun)](https://bun.sh)

Full Chromium automation in **3 tools, 4.0 KB**. Same pages, same clicks, same scrapes — without the 25-tool handshake eating your context window before you load a page.

**Measured, not marketed:** `tools/list` is **3,955 bytes** here vs **20,286 bytes** for `@playwright/mcp@latest` — **5.1× smaller**, ~16.3 KB saved every session. Re-observing after an action costs **70 tokens** instead of **3,857** (Playwright has no delta mode). Across 8 real websites, end-to-end: **15.7× cheaper** and **1.43× faster**. Full method, per-site numbers, and an honest account of where this loses: [`docs/FINDINGS.md`](docs/FINDINGS.md).

## Install (Bun-only)

Requires [Bun](https://bun.sh) 1.4+. Installs from npm in seconds — the tarball is ~16 kB ([`effing-use` v0.3.0](https://www.npmjs.com/package/effing-use)):

```bash
# No install needed — bunx fetches from npm on first run
bunx --package effing-use effing-use               # CLI (needs running server)
bunx --package effing-use effing-use-http          # HTTP MCP on :3123 (/mcp) — shared across editors
bunx --package effing-use effing-use-stdio         # STDIO MCP (single editor)
bunx playwright install chromium --only-shell       # one-time Chromium download (~150 MB)
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

### npm vs source

| Source                                | Command                                                 | When to use                                                                    |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **npm** (`bunx --package effing-use`) | `effing-use`, `effing-use-http`, `effing-use-stdio`     | Recommended — always matches published `package.json` version, no clone needed |
| **source** (`bun src/*.ts`)           | `bun src/cli.ts`, `bun src/http.ts`, `bun src/index.ts` | Local dev / unreleased changes                                                 |

Both expose the same 3 bins: `effing-use` = CLI (HTTP client), `effing-use-stdio` = MCP stdio, `effing-use-http` = MCP http. Don't mix them — `effing-use` alone is **not** an MCP server (it prints CLI help and exits, causing `Failed to parse message` / `MCP server has stopped`).

## Run it in 60 seconds (recommended path)

**Step 1/3 — Start the server.** One server, every local editor:

```bash
# Docker (recommended — Chromium baked in, no local install)
docker compose up --build -d
curl http://localhost:3123/healthz   # {"ok":true,"name":"effing-use"}

# Or without Docker
bun install
bunx playwright install chromium --only-shell
bun src/http.ts   # or: bunx --package effing-use effing-use-http
```

The HTTP server binds `0.0.0.0:3123` inside Docker (so forwarded ports work) and sets `idleTimeout: 0` so the MCP SSE stream isn't killed after 10s of idle time. Plain HTTP on loopback is intentional — add TLS at the edge for remote use.

**Step 2/3 — Connect.** Pick one transport:

**HTTP (shared — recommended for multiple VS Code windows):**

```json
// ~/.config/Code/User/mcp.json  (global, all workspaces) or .vscode/mcp.json
{
  "servers": {
    "effing-use": { "type": "http", "url": "http://localhost:3123/mcp" }
  }
}
```

One Docker/bun process serves every window. Use same `sessionId` to share tabs, different `sessionId` to isolate.

**STDIO (isolated — one browser per window):**

```json
{
  "servers": {
    "effing-use": {
      "type": "stdio",
      "command": "bunx",
      "args": ["--package", "effing-use", "effing-use-stdio"],
      "env": {
        "BROWSER_HEADLESS": "true",
        "OUTPUT_DIR": "${workspaceFolder}/.browser-use"
      }
    }
  }
}
```

From source: `command: "bun"`, `args: ["/absolute/path/to/effing-use/src/index.ts"]`.

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

### CLI usage

The CLI needs a running HTTP server (`EFFING_USE_URL` defaults to `http://localhost:3123/mcp`):

```bash
# Observe
effing-use observe --kind snapshot --mode delta --session dev
effing-use observe --kind title --session dev
effing-use observe --kind screenshot --session dev

# Act
effing-use act --action open --value https://example.com --session dev
effing-use act --action click --target e5 --expect 'url~/dashboard' --session dev
effing-use act --action batch --file steps.json --session dev

# Extract
effing-use extract --kind text --selector main --session dev
effing-use extract --kind state --session dev

# With custom server URL
EFFING_USE_URL=http://localhost:3123/mcp effing-use observe --kind snapshot
```

From npm without global install: `bunx --package effing-use effing-use observe --kind snapshot`.

### Published images (GHCR + Docker Hub)

Every `v*` tag publishes multi-arch images (`linux/amd64`, `linux/arm64`) to both registries:

```bash
docker pull obele9630/effing-use:latest                # Docker Hub
docker pull ghcr.io/michael-obele/effing-use:latest    # GHCR

# Chromium needs --init (zombie reaping) and --ipc=host (/dev/shm)
docker run --rm --init --ipc=host -p 3123:3123 obele9630/effing-use:latest
curl localhost:3123/healthz                            # {"ok":true,...}
```

Tags: `latest`, full version (e.g. `0.2.1`), `major.minor`, and `sha-<sha>`. The Docker Hub repo's short description, full description (this README), and topics are synced from CI on every release — see [docs/RELEASING.md](docs/RELEASING.md).

### Docker

```bash
docker compose up --build -d          # build + start (0.0.0.0:3123, idleTimeout:0)
docker compose logs -f effing-use     # tail logs
curl http://localhost:3123/healthz    # health check
docker compose down                   # stop (add -v to remove volumes)
# Rebuild after pulling new code
docker compose up --build -d
# Orphaned old container holding :3123? (renamed service)
docker rm -f effing-use-computer-use-1 && docker compose up -d
```

Compose details: `restart: unless-stopped`, `init: true` + `ipc: host` (Playwright flags), `.browser-use/` bind-mounted, `EFFING_PORT` overrides host port (`EFFING_PORT=4000 docker compose up -d`).

### Opening a local dev server (`http://localhost:5175`) from the container

A dev server started with plain `vite dev` / `next dev` binds **127.0.0.1 only**. Inside
Docker Desktop that is unreachable — the container runs in a LinuxKit VM with its own
network namespace — so three obvious fixes all fail:

| Attempt                                 | Result                                                |
| --------------------------------------- | ----------------------------------------------------- |
| `open http://localhost:5175`            | `ERR_CONNECTION_REFUSED` (container's own loopback)   |
| `open http://host.docker.internal:5175` | `403 Blocked request` — Vite ≥6 `server.allowedHosts` |
| `docker run --network host`             | maps to the **VM**, not your machine — still refused  |

**You do not need to edit the app's `vite.config.ts`.** `src/browser/bridge.ts` splices
the container's loopback to the host gateway and rewrites the HTTP `Host:` header back
to `localhost`, so the dev server's host allow-list is satisfied. The model still types
the plain URL:

```json
{
  "ok": true,
  "action": "open",
  "url": "http://localhost:5175/",
  "title": "Sepia — Memory Server for AI Agents",
  "bridgedVia": "host.docker.internal"
}
```

- Engaged **only** when a loopback URL is requested and the direct dial fails, so a
  native `bun src/http.ts` run pays nothing (one extra probe).
- `EFFING_BRIDGE=0` disables it, `EFFING_BRIDGE_HOST` overrides the gateway.
- If no gateway answers, you get `E_LOCALHOST_UNREACHABLE` with the fix in `hint`
  (add `extra_hosts: ["host.docker.internal:host-gateway"]`, or run natively) instead of
  a bare connection error.
- `compose.yaml` ships the `extra_hosts` entry (required on Linux engines; a no-op on
  Docker Desktop).

## Why agents prefer 3 tools

- 🪶 **Tiny handshake, full surface** — `browser_act` (32 actions), `browser_observe` (8 kinds + `mode`/`scope`), `browser_extract` (8 kinds incl. `state`). No schema bloat, no guessing which of 24 tools to call.
- 🧠 **Context-safe by default** — snapshots capped at `OUTPUT_MAX_CHARS` (default 4000); full YAML/text saved under `.browser-use/`, never dumped inline. HN snapshot: 4,034-char preview, full file on disk.
- 🖼️ **File paths, not base64** — screenshots, PDFs, traces return paths like `.browser-use/shot-*.png`. Read the file only when needed.
- ⚡ **One call, not five** — `batch` runs fill+press flows in one turn (max 20 steps, stops on first error). `goal` plans or returns `E_GOAL_UNCLEAR` + `suggestedSteps` instead of hallucinating.
- 🐳 **Shared, not spawned** — one Docker server serves every local VS Code instance. No per-client `npx` spawn.

## Harness — verify, delta, state, replay

v2 turns the browser into a harness: AI actions are verifiable, diffable, and replayable — not just fire-and-forget clicks.

**1. Verify — fingerprints + expectations + failure contract**

- **Fingerprint registry** (`src/browser/identity.ts`): every `eN` ref is fingerprinted (role, accessibleName, textHash, box, pathHash). Stale refs rebind only on an UNAMBIGUOUS identity match (`rebound:true`); if several elements match equally they fail with `E_STALE` + hint — the engine never guesses a target.
- **Expect mini-language** (`expect` on any `browser_act`): `url~/dashboard` | `text~/Saved/` | `visible=.modal` | `gone=.spinner` — evaluated server-side, returns `E_EXPECT` / `E_BAD_EXPECT` on mismatch instead of hallucinated success. ReDoS-capped and regex-validated.
- **Failure contract**: after an uncertain mutation the engine sets `mustObserve:true` — next mutation fails with `E_MUST_OBSERVE` until you re-snapshot. No blind chains.
- **Evidence envelope**: every `browser_act` returns `effect: { urlChanged, urlBefore/After, domChanged, consoleErrors, networkFailures }` capped at `EFFECT_MAX_CHARS` (800) so the agent sees what actually happened.

**2. Delta — pay only for what changed**

- `browser_observe kind=snapshot mode=delta` (default) — MutationObserver dirty flag + baseline diff. Returns only `[changed]` lines or `unchanged:true` on stable pages (~90% token saving). `mode=full` for complete dump, `scope="<css>"` for subtree.
- `DELTA_DEFAULT=true` — flip to `false` to default to full snapshots.

**3. State — per-session memory**

- `browser_act action=note value="..."` appends to `notes` (capped `STATE_MAX_LINES=40`), `browser_extract kind=state` reads `notes` + `lastActions` ring (last 10). Persisted to `.browser-use/state/<session>.md` so agents survive context compaction.

**4. Record → Compile → Replay — deterministic macros**

- `record_start` / `record_stop` captures every step with resolved selectors + fingerprints. Secrets auto-redacted (`RECORD_REDACT=true`, `«redacted»` for password/otp/token fields).
- `compile` generates `.browser-use/macros/<name>.{ts,md}` — a Playwright `run(page)` function + a `SKILL.md` doc. Irreversible steps (`submit`/`pay`/`delete`/etc.) are flagged `requiresApproval`.
- `replay` replays deterministically; pauses with `E_APPROVAL_REQUIRED` until `approve:true` if any irreversible step exists.

**5. CLI — same engine, no MCP client**

- `effing-use observe/act/extract` over `EFFING_USE_URL` (`http://localhost:3123/mcp`) — for terminal agents, scripts, and CI. See [CLI usage](#cli-usage).

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

Errors are always `{ ok: false, code, message, hint }` with `E_NOT_FOUND | E_TIMEOUT | E_NO_PAGE | E_BAD_INPUT | E_GOAL_UNCLEAR | E_STALE | E_EXPECT | E_BAD_EXPECT | E_MUST_OBSERVE | E_APPROVAL_REQUIRED | E_LOCALHOST_UNREACHABLE` — never a stack trace.

## effing-use vs Playwright MCP

Measured with `bench/bench.mjs` against the **same** local app
(`http://localhost:5175`), same MCP Streamable-HTTP transport, same Chromium
(`bunx @playwright/mcp@latest --port 8931`). Reproduce:

```bash
bunx @playwright/mcp@latest install-browser chrome-for-testing
bunx @playwright/mcp@latest --port 8931 --host 127.0.0.1 --browser chromium --headless &
PLAYWRIGHT_MCP_URL=http://localhost:8931/mcp EFFING_USE_URL=http://localhost:3123/mcp \
  bun bench/bench.mjs --target http://localhost:5175/
```

> Use `http://localhost:8931` — Playwright MCP has its own DNS-rebinding guard and
> answers `403 Access is only allowed at localhost:8931` for `127.0.0.1`.

|                  | effing-use                                      | Playwright MCP                    |
| ---------------- | ----------------------------------------------- | --------------------------------- |
| `tools/list`     | **3,955 B / 3 tools** (~989t)                   | **20,286 B / 25 tools** (~5,072t) |
| Snapshot         | capped 4 KB preview + file                      | full accessibility tree           |
| Re-observe (2nd) | `unchanged:true` — **70 t**                     | full tree again — **3,857 t**     |
| Whole flow       | **~300 t / 4 calls**                            | **~7,775 t / 3 calls**            |
| End-to-end       | **~1,277 t**                                    | **~12,847 t**                     |
| **Verdict**      | **10.1× cheaper** (5.2× schema, **25.9× flow**) | —                                 |

The flow gap is the point: Playwright MCP has no delta mode, so a second identical
`snapshot` costs another 3,857 tokens. effing-use's second `observe` is 70.

Plan gates (effing-use-v2 §10), re-measured 2026-09-29:

| Gate                                 | Target   | Measured                        |
| ------------------------------------ | -------- | ------------------------------- |
| §10.2 tools / schema size            | 3 / <10K | 3 / 3,955 B                     |
| §10.6 TodoMVC add-todo delta vs full | < 25 %   | **24.3 %** (content-to-content) |
| §10.6 clean-page observe             | ~60 t    | **42 t**                        |
| §10.7 record → compile → replay      | 0 LLM    | 0 LLM, `expect: pass`           |

Need Firefox/WebKit, device emulation, or persistent profiles? Use Playwright MCP. Need context budget for Chromium work? Stay here. Full breakdown in [`docs/COMPARISON.md`](docs/COMPARISON.md).

## Record → replay (harness)

```bash
# MCP — capture any flow, compile to code + skill, replay deterministically
browser_act action=record_start value=my-flow
# ... do the flow (clicks, fills, etc.) ...
browser_act action=record_stop                          # -> .browser-use/recordings/my-flow.json (secrets redacted)
browser_act action=compile value=my-flow                # -> .browser-use/macros/my-flow.{ts,md}
browser_act action=replay value=my-flow                 # pauses with E_APPROVAL_REQUIRED if irreversible
browser_act action=replay value=my-flow approve=true    # replay with approval

# CLI — same flow over HTTP
EFFING_USE_URL=http://localhost:3123/mcp effing-use act --action record_start --value my-flow
# ... do the flow via CLI or MCP ...
EFFING_USE_URL=http://localhost:3123/mcp effing-use act --action record_stop
EFFING_USE_URL=http://localhost:3123/mcp effing-use act --action compile --value my-flow
EFFING_USE_URL=http://localhost:3123/mcp effing-use act --action replay --value my-flow --approve true
```

Artifacts: `recordings/*.json` (raw steps), `macros/*.ts` (Playwright `run(page)`), `macros/*.md` (skill doc). Redaction and approval gates are on by default (`RECORD_REDACT=true`).

## Config

Env defaults in [`.env.example`](.env.example): `BROWSER_HEADLESS`, `BROWSER_VIEWPORT_W/H`, `BROWSER_TIMEOUT_MS`, `OUTPUT_DIR` (`.browser-use/`, gitignored), `OUTPUT_MAX_CHARS`, `ALLOW_EVAL`, `DELTA_DEFAULT`, `EFFECT_MAX_CHARS`, `STATE_MAX_LINES`, `RECORD_REDACT`, `EFFING_USE_URL`.

Agent skill: `skills/effing-use/SKILL.md` (skills.sh-ready).

## Verify

```bash
bunx tsc --noEmit   # 0 errors
bun test            # 34 pass
bunx prettier --check src/ tests/ bench/ compose.yaml
```

Live regression (Docker, `localhost:5175` bridged + TodoMVC):

```bash
docker compose up -d --build
bunx tsc --noEmit && bun test
MCP_URL=http://localhost:3123/mcp bun /tmp/mcp-call.mjs browser_act \
  '{"action":"open","value":"http://localhost:5175/","sessionId":"check"}'
```

`bench/bench.mjs` is the reproducible comparison against Playwright MCP described in
[effing-use vs Playwright MCP](#effing-use-vs-playwright-mcp).
