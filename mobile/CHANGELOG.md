# Changelog

## 0.1.0

First release. Android + Capacitor.

- **3 tools, 3.9 KB handshake**: `mobile_act` (20 actions), `mobile_observe`
  (13 kinds), `mobile_extract` (5 kinds). Measured with
  `bun ../bench/mcp-size.ts bun src/index.ts`.
- **Attach over adb**: `pidof` → `/proc/net/unix` →
  `webview_devtools_remote_<pid>` → `adb forward tcp:0` → `/json/list` → CDP
  WebSocket. No Appium, no drivers, no WebDriverAgent.
- **One injected runtime** (`Page.addScriptToEvaluateOnNewDocument`) so each
  action is a single `Runtime.evaluate`, and it survives reloads.
- **Snapshot with refs**: visible interactive elements as `[eN]`, shadow DOM
  pierced, hidden/`aria-hidden` subtrees skipped, `mode=delta` at ~20 tokens
  when nothing changed.
- **Input**: `Input.dispatchTouchEvent` for tap/swipe/scroll, native-setter
  `fill` with `composed` events, `Input.insertText` for typing, settle after
  every dispatched input so the next observation sees the result.
- **Evidence**: journal-backed `errors`/`timeline`, console and network rings,
  Capacitor plugin trace, `CapacitorHttp` detection, screenshot via
  `adb exec-out screencap`, HAR export.
- **Docker**: image talks to the host's adb server (`adb -a`); `MOBILE_CDP_HOST`
  makes the forwarded devtools port reachable from the container.
- **Verified**: Phase 0 loop on an Android emulator (attach 230–560 ms, snapshot
  19–47 ms, tap 64–364 ms, no-op delta 10–20 ms) both natively and through
  Docker.
