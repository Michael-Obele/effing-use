# effing-use-mobile — your Capacitor app's DOM, over MCP

Three MCP tools that drive an Android Capacitor app through **adb and the
WebView devtools protocol** — no Appium, no drivers, no WebDriverAgent, no
screenshots in the normal loop.

A package of its own, `effing-use-mobile`. `tools/list` is **3.9 KB / 3 tools**
(~1.1k tokens); `@mobilenext/mobile-mcp` is 33.6 KB and `appium-mcp` is 43.3 KB,
measured the same way.

> [!IMPORTANT]
> **Not yet published.** The package is not on npm and the image is not on a
> container registry yet — `bunx --package effing-use-mobile …` fails until
> then. Publishing both is planned for a later release. Run from source, or
> build the image locally (`docker compose -f mobile/compose.yaml up --build`).

| Tool             | Values                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile_act`     | `attach, launch, terminate, reload, open_url, tap, fill, type, press, swipe, scroll, back, wait, deep_link, permission, orientation, appearance, eval, note, batch` |
| `mobile_observe` | `snapshot, screenshot, url, title, console, network, errors, logs, plugins, device, apps, state, timeline`                                                          |
| `mobile_extract` | `text, html, table, query, har`                                                                                                                                     |

## Install

### Bun (no container)

```bash
# run from your Capacitor project root: appId in capacitor.config.* is the package
bunx --package effing-use-mobile effing-use-mobile
```

Requires `adb` on PATH and a **debug build** running on a device or emulator
(Capacitor only enables WebView debugging in development builds).

### Docker

The container has no USB bus, so it talks to the **adb server on your host**.

```bash
# 1. On the host, once: adb must listen on all interfaces, not just loopback.
adb kill-server && adb -a -P 5037 start-server

# 2a. Daemon (HTTP transport) — one container, shared by every editor.
MOBILE_PACKAGE=com.your.app docker compose -f mobile/compose.yaml up -d --build mobile-http
curl -s localhost:3130/healthz        # {"ok":true,...}
curl -s localhost:3130/debug          # which device/app it is attached to

# 2b. stdio — the client spawns a container per session (`-i` keeps stdin open).
docker compose -f mobile/compose.yaml build
docker compose -f mobile/compose.yaml run --rm -i mobile
```

`docker run` by hand, same thing:

```bash
docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037 \
  -e MOBILE_CDP_HOST=host.docker.internal \
  -e MOBILE_PACKAGE=com.your.app \
  -v "$PWD/out:/data" \
  effing-use-mobile:local
```

Why those two env vars: `adb forward` binds the forwarded devtools port on the
machine running the **adb server** (the host), so the container must dial the
host, not its own loopback. `adb -a` is what makes those forwards reachable from
outside the host.

stdio exits when its client does, so it can never be a container that stays up.
`mobile-http` is the service to leave running: it holds one adb forward and one
CDP socket, and every editor shares them — the same shape as the browser server.

MCP client entries — daemon first, then the per-session fallback:

```json
{
  "mcpServers": {
    "effing-use-mobile": { "type": "http", "url": "http://localhost:3130/mcp" },
    "effing-use-mobile (stdio)": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--add-host=host.docker.internal:host-gateway",
        "-e",
        "ADB_SERVER_SOCKET=tcp:host.docker.internal:5037",
        "-e",
        "MOBILE_CDP_HOST=host.docker.internal",
        "-e",
        "MOBILE_PACKAGE=com.your.app",
        "-v",
        "${workspaceFolder}/.effing-mobile:/data",
        "ghcr.io/michael-obele/effing-use-mobile:latest"
      ]
    }
  }
}
```

### Agent skill

`skills/effing-use-mobile/SKILL.md` is the half of this package that is not
code: the observe → act → delta loop, what a stale ref means, the scroll
semantics (`value: "right"` reveals what is to the right), and how to read an
`E_*` envelope. Without it an agent re-derives the tool surface every session.

```bash
# into this project (.agents/skills/, plus .claude/skills/ for Claude Code)
npx skills add Michael-Obele/effing-use --skill effing-use-mobile

# every project instead
npx skills add Michael-Obele/effing-use --skill effing-use-mobile -g

# already have the package installed (repo or tarball)? read it from there
npx skills add ./node_modules/effing-use-mobile/skills/effing-use-mobile
```

That is Vercel's [skills CLI](https://github.com/vercel-labs/skills); `bunx
skills` works the same. To skip the CLI, copy
`skills/effing-use-mobile/` into `.agents/skills/` (Copilot, Codex, Cursor,
Gemini CLI, OpenCode), `~/.copilot/skills/` for a global install, or
`.claude/skills/`.

A skill with no MCP entry installed can describe the tools but cannot call one —
set up the server above first, then the skill.

## The loop

1. `mobile_observe` `kind: "state"` → attaches and reports device, app, platform,
   plugin list, whether `CapacitorHttp` is on, and the journal path. If attaching
   failed, `attachError` says why.
2. `mobile_observe` `kind: "snapshot"` → `[eN]` refs. Pass `mode: "delta"` later:
   an unchanged UI costs ~20 tokens.
3. `mobile_act` — targets are refs (`e12`) or CSS selectors. `fill` takes a ref
   only. `batch` runs `steps[]` in order and stops at the first failure.
4. `mobile_observe` `kind: "snapshot"` `mode: "delta"` → what changed.
5. `mobile_extract` `kind: "text" | "html" | "table" | "query" | "har"` to scrape.

## What makes it different from a device driver

- **Shadow DOM is pierced.** Ionic/Stencil/Shoelace keep the real `<input>` in a
  shadow root; the snapshot refs the host (what a tap hits) and `fill` writes to
  the native control, firing `input`/`change` with `composed: true` so app-level
  listeners see it.
- **Hidden elements are skipped** — zero-size, `display:none`, `visibility:hidden`
  and `aria-hidden` subtrees never become refs.
- **Covered taps are reported.** A toast over the button returns
  `hit: false, coveredBy: "<tag>"` instead of a silent no-op.
- **Scrolling is aimed and measured.** `scroll` with `value: "left|right|up|down"`
  (the direction of the _content_ you want to see) names the scroll region with
  an optional `target`, walks up to its nearest scrollable ancestor, and reports
  `moved`, `delta`, `from`, `to`, `max`, `scroller` and `mechanism`. A sideways
  rail inside a phone-width page is therefore one call, not a guess: on a live
  app it moved 247 px per call and answered `atEnd: true` at the end instead of
  pretending to work. `swipe` stays for drag-only carousels.
- **Input is settled before you look.** Touch and key events reach the page
  asynchronously; without settling, a delta taken right after a tap reads the old
  DOM and says `unchanged: true`.
- **Plugin calls are traced.** `Capacitor.toNative`/`fromNative` are wrapped, so
  `kind: "plugins"` returns plugin, method, redacted args, duration and error for
  the last 50 calls.
- **`CapacitorHttp` is called out.** With it on, `fetch`/XHR run natively and CDP
  sees nothing; `kind: "network"` says so instead of reporting "no requests".
- **Every failure carries evidence**: `code`, `message`, `hint`, `journal` path
  and `callId`. `kind: "errors"` dedupes page errors, console errors and failed
  requests with first/last seen and counts.

## Codes

`E_NO_DEVICE`, `E_AMBIGUOUS`, `E_NO_APP`, `E_NO_WEBVIEW`, `E_STALE`,
`E_NOT_FOUND`, `E_CDP`, `E_CDP_CLOSED`, `E_PAGE`, `E_RUNTIME`, `E_EVAL_OFF`,
`E_BAD_INPUT`, `E_ADB`, `E_TIMEOUT`.

## Config

| Env                     | Default                           | Meaning                                                        |
| ----------------------- | --------------------------------- | -------------------------------------------------------------- |
| `MOBILE_DEVICE`         | the only online device            | adb serial                                                     |
| `MOBILE_PACKAGE`        | `appId` from `capacitor.config.*` | Android package                                                |
| `MOBILE_CDP_HOST`       | `127.0.0.1`                       | host owning the adb forward (`host.docker.internal` in Docker) |
| `MOBILE_OUTPUT_DIR`     | `.effing-mobile`                  | journal + artifacts                                            |
| `MOBILE_SETTLE_MS`      | `120`                             | minimum wait after a dispatched input                          |
| `MOBILE_SETTLE_MAX_MS`  | `600`                             | cap on waiting for the DOM to stop changing                    |
| `MOBILE_SETTLE_POLL_MS` | `50`                              | how often the page signature is sampled while settling         |
| `MOBILE_PORT`           | `3130`                            | port for the HTTP entry (`src/http.ts`)                        |
| `MOBILE_ALLOW_EVAL`     | `0`                               | allow `act action=eval`                                        |
| `MOBILE_JOURNAL`        | on                                | append-only JSONL evidence                                     |
| `MOBILE_SNAPSHOT_MAX`   | `150`                             | refs per snapshot                                              |
| `MOBILE_TIMEOUT_MS`     | `20000`                           | adb/CDP timeout                                                |

## Boundaries

Android only. Debug builds only. No request/response bodies. `act action=eval`
is off unless asked for — it can reach native plugins.

## Development

```bash
bun install
bunx tsc --noEmit && bun test          # 20 unit tests, no device needed
MOBILE_LIVE_TEST=1 bun test            # WebView runtime against real Chrome
docker compose build                   # image
```
