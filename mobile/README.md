# effing-use-mobile — your Capacitor app's DOM, over MCP

Three MCP tools that drive an Android Capacitor app through **adb and the
WebView devtools protocol** — no Appium, no drivers, no WebDriverAgent, no
screenshots in the normal loop.

Published as its own package: `effing-use-mobile` on npm, and as a container
image. `tools/list` is **3.9 KB / 3 tools** (~1.1k tokens); `@mobilenext/mobile-mcp`
is 33.6 KB and `appium-mcp` is 43.3 KB, measured the same way.

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

# 2. Build and run (stdio MCP — `-i` keeps stdin open).
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

An MCP client entry for Docker:

```json
{
  "mcpServers": {
    "effing-use-mobile": {
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

| Env                   | Default                           | Meaning                                                        |
| --------------------- | --------------------------------- | -------------------------------------------------------------- |
| `MOBILE_DEVICE`       | the only online device            | adb serial                                                     |
| `MOBILE_PACKAGE`      | `appId` from `capacitor.config.*` | Android package                                                |
| `MOBILE_CDP_HOST`     | `127.0.0.1`                       | host owning the adb forward (`host.docker.internal` in Docker) |
| `MOBILE_OUTPUT_DIR`   | `.effing-mobile`                  | journal + artifacts                                            |
| `MOBILE_SETTLE_MS`    | `120`                             | wait after a dispatched input                                  |
| `MOBILE_ALLOW_EVAL`   | `0`                               | allow `act action=eval`                                        |
| `MOBILE_JOURNAL`      | on                                | append-only JSONL evidence                                     |
| `MOBILE_SNAPSHOT_MAX` | `150`                             | refs per snapshot                                              |
| `MOBILE_TIMEOUT_MS`   | `20000`                           | adb/CDP timeout                                                |

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
