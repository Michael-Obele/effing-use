# Changelog

Notable changes per release. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); this project uses [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-11-19

Long-session debugging: evidence now survives the in-memory rings, context
compaction, and idle reaping.

### Added

- **Persistent session journal** — append-only per-session JSONL at
  `${OUTPUT_DIR}/sessions/<session-id>/journal.jsonl`, with `journal.1.jsonl`
  rotation. Enabled by default; redacted by default; each string field clipped to
  4,000 chars. Config: `EFFING_JOURNAL` (default on), `EFFING_JOURNAL_MAX_BYTES`
  (default 2,000,000).
- **Browser event capture** — console, page errors, failed requests, responses,
  main-frame navigation, and crashes, all journaled.
- `browser_observe kind=errors` — deduplicated page errors, console errors, and
  network failures with first/last seen and counts.
- `browser_observe kind=console` / `kind=network` — journal-backed reads with
  `since`, `filter`, `level`, `offset`, and `limit` (default 20, cap 200). Keys
  `logs` / `requests` are unchanged; when the journal is disabled these fall back
  to the in-memory rings.
- `browser_extract kind=timeline` — one compact line per call/event
  (default 100, cap 500).
- **Call journaling** — every tool call is recorded (tool, key, duration, ok,
  code, url, path). Every error envelope now carries a `journal` path so evidence
  can be read without re-running the flow.
- **CPU telemetry** — `GET /metrics` (Prometheus text) and `GET /debug` (JSON)
  on the HTTP server: per-tool timings, slow-call list, session idle age.

### Changed

- DOM change detection and `text`-expect use `textContent` (layout-free) instead
  of `innerText`, and the element fingerprint no longer calls
  `getBoundingClientRect` in the hot path — cheaper snapshots under software GL.
- `compose.yaml` caps the container at 2 CPUs / 2 GB and ships idle-lifecycle,
  asset-blocking, and settle defaults.

### Notes

- The MCP surface stays at 3 tools; `tools/list` is 10,620 bytes.
- No request/response bodies, snapshot history, eval, frames, or HAR in this
  release. See `docs/PLAN-debug-sessions.md` for the deferred map.

## [0.3.1] — 2026-09-30

- Live multi-site benchmark, scoped-ref, slow-load, and `looksEmpty` fixes. See
  `docs/FINDINGS.md`.

## [0.3.0] — 2026-09-29

- Loopback bridge, delta/macro/replay fixes, `host.docker.internal` support.
