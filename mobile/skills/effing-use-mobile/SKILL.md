---
name: effing-use-mobile
description: Drive an Android Capacitor app through 3 token-efficient MCP tools (mobile_act, mobile_observe, mobile_extract) over adb and the WebView devtools protocol. Use when launching, driving, debugging or testing a Capacitor or other hybrid Android app from an agent.
license: MIT
compatibility: Requires the effing-use-mobile MCP server (Bun) or its container image, adb, and a running debug build with WebView debugging enabled. Android only in v1.
metadata:
  repo: Michael-Obele/effing-use
  tools: mobile_act,mobile_observe,mobile_extract
---

# effing-use-mobile — token-efficient Android WebView control

Three tools, ~3.9 KB of `tools/list` (~1.1k tokens). The app's DOM is the
source of truth; adb is the shell around it. No Appium, no drivers, no WDA, no
screenshots in the normal loop.

## Install

```bash
# Bun, from the Capacitor project root (appId becomes the package name)
bunx --package effing-use-mobile effing-use-mobile

# Docker daemon: one container, /mcp on :3130 (usecurl /debug to see the attach)
MOBILE_PACKAGE=com.your.app docker compose -f mobile/compose.yaml up -d --build mobile-http

# Docker stdio: container per client; in the container use
# MOBILE_CDP_HOST=host.docker.internal and start the host adb server with
# `adb -a -P 5037 start-server`
docker compose -f mobile/compose.yaml run --rm -i mobile
```

Start the server from the Capacitor project root — the `appId` in
`capacitor.config.*` is the package name, so nothing has to be configured. In a
container, mount the project and pass `MOBILE_PACKAGE` instead.

## The loop

1. `mobile_observe` `kind: "state"` → attaches, and reports device, app,
   platform, plugin list, whether `CapacitorHttp` is on, and the journal path.
   If attaching failed, `attachError` says why (debug build? app running?).
2. `mobile_observe` `kind: "snapshot"` → `[eN]` refs. Pass `mode: "delta"` on
   later observations: unchanged UI costs ~20 tokens.
3. `mobile_act` — `tap`/`fill`/`type`/`press`/`swipe`/`scroll`/`back`/`open_url`/
   `deep_link`/`permission`/`orientation`/`appearance`. Targets are refs (`e12`)
   or CSS selectors. `batch` runs `steps[]` in order and stops at the first
   failure, reporting `failedAt`.
4. `mobile_observe` `kind: "snapshot"` `mode: "delta"` → what changed.
5. `mobile_extract` `kind: "text"|"html"|"table"|"query"|"har"` to scrape.

## Refs and staleness

Refs are positions in the last snapshot and are re-numbered each snapshot.
A ref whose element was replaced returns `E_STALE` — re-observe, never retry
blindly. `fill` takes a ref only (`eN`), not a selector: it needs the exact
control to write into.

## What makes this different from a device driver

- **Shadow DOM is pierced.** Ionic/Stencil/Shoelace components keep the real
  `<input>` in a shadow root; the snapshot refs the host (that is what a tap
  hits) but `fill` writes to the native control and fires `input`/`change` with
  `composed: true`, so app-level listeners see it.
- **Hidden elements are skipped.** Zero-size, `display:none`, `visibility:hidden`
  and `aria-hidden` subtrees never become refs.
- **Plugin calls are traced.** `Capacitor.toNative`/`fromNative` are wrapped, so
  `mobile_observe` `kind: "plugins"` returns plugin, method, redacted args,
  duration and error for the last 50 calls — the camera-denied case is one call,
  not a repro.
- **Covered taps are reported.** If a toast or overlay sits over the target, the
  tap result carries `hit: false` and `coveredBy`. Never read `ok: true` on a tap
  as "the app reacted"; the following delta is the proof.
- **Input settles before you look.** Touch and key events are dispatched
  asynchronously, so the server waits two animation frames plus `MOBILE_SETTLE_MS`
  before returning. That is why a delta right after `tap` is trustworthy.
- **`CapacitorHttp` is called out.** With it enabled, `fetch`/XHR run natively
  and CDP sees nothing; `kind: "network"` says so instead of reporting "no
  requests".
- **Failures carry evidence.** Every `E_*` envelope has `code`, `message`,
  `hint`, `journal` (path) and `callId`. `kind: "errors"` dedupes page errors,
  console errors and failed requests with first/last seen and counts.

## Codes

`E_NO_DEVICE`, `E_AMBIGUOUS` (two devices), `E_NO_APP`, `E_NO_WEBVIEW` (release
build, or app not running), `E_STALE`, `E_NOT_FOUND`, `E_CDP`, `E_CDP_CLOSED`,
`E_PAGE`, `E_RUNTIME`, `E_EVAL_OFF`, `E_BAD_INPUT`, `E_ADB`, `E_TIMEOUT`.

## Config

| Env                   | Default                           | Meaning                                             |
| --------------------- | --------------------------------- | --------------------------------------------------- |
| `MOBILE_DEVICE`       | the only online device            | adb serial                                          |
| `MOBILE_PACKAGE`      | `appId` from `capacitor.config.*` | Android package                                     |
| `MOBILE_CDP_HOST`     | `127.0.0.1`                       | host owning the adb forward; `host.docker.internal` |
| `MOBILE_OUTPUT_DIR`   | `.effing-mobile`                  | journal + artifacts                                 |
| `MOBILE_SETTLE_MS`    | `120`                             | wait after a dispatched input                       |
| `MOBILE_ALLOW_EVAL`   | `0`                               | allow `act action=eval`                             |
| `MOBILE_JOURNAL`      | on                                | append-only JSONL evidence                          |
| `MOBILE_SNAPSHOT_MAX` | 150                               | refs per snapshot                                   |
| `MOBILE_TIMEOUT_MS`   | 20000                             | adb/CDP timeout                                     |

## Boundaries in v1

Android only. Debug builds only (release builds are not inspectable). No
request/response bodies. `act action=eval` is off unless asked for — it can reach
native plugins.
