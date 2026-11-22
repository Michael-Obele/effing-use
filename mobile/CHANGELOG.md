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
- **Input**: `Input.dispatchTouchEvent` for tap/swipe, native-setter `fill`
  with `composed` events, `Input.insertText` for typing, settle after every
  dispatched input so the next observation sees the result.
- **`scroll` that verifies itself**: `Input.synthesizeScrollGesture` aimed at the
  target's nearest scrollable ancestor, point clamped into the visible part of
  that scroller, and a re-read of `scrollLeft`/`scrollTop` afterwards. Returns
  `moved`, `delta`, `from`, `to`, `max`, `scroller`, `mechanism`, or
  `atEnd: true` with a hint when there is nothing further to scroll.
- **Evidence**: journal-backed `errors`/`timeline`, console and network rings,
  Capacitor plugin trace, `CapacitorHttp` detection, screenshot via
  `adb exec-out screencap`, HAR export.
- **Docker**: image talks to the host's adb server (`adb -a`); `MOBILE_CDP_HOST`
  makes the forwarded devtools port reachable from the container.
- **Two transports**: `effing-use-mobile` (stdio, spawned per client) and
  `effing-use-mobile-http` (`/mcp` on `:3130`, one long-lived process sharing the
  adb forward). The compose file runs stdio as `mobile` and the daemon as
  `mobile-http`, so the container can stay up the way the browser server does.
- **Verified**: Phase 0 loop on an Android emulator (attach 230–560 ms, snapshot
  19–47 ms, tap 64–364 ms, no-op delta 10–20 ms) both natively and through
  Docker.
- **First real Capacitor app**: `app.lolia.mobile` against a live Vite dev server.
  Attach with zero configuration (appId read from `capacitor.config.ts`),
  `platform: android` and 5 real plugins from the live bridge, 124-ref snapshot,
  155 Vite module requests captured after a reload, `fill` filtering the app's own
  search to "Au Gold", and screenshot evidence.
- **Settle is quiescence-based**: a fixed 120 ms window reported `unchanged` for
  a tap that opened a command palette 150–370 ms later. After an input the server
  now polls a page signature until it stabilises (`MOBILE_SETTLE_MAX_MS`, default
  600 ms, `MOBILE_SETTLE_POLL_MS` 50 ms). Measured: no-op tap 342 ms total,
  overlay-opening tap 782 ms, and both report the truth.
- **`observe kind=state` reports native focus**: `focusedWindow`, `appHasFocus`
  and `nativeOverlay`. An Android ANR dialog occupied the screen while the DOM
  still looked healthy, and every tap "succeeded" with no visible change.
- **`unchanged: true` deltas now include `url` and `title`**, so a quiet page is
  distinguishable from a silent navigation.
