# Troubleshooting — effing-use

## Port already in use

Port 3000 is a popular squat (e.g. other MCP servers). Diagnose:

```bash
ss -tlnp | grep -E ':3000|:3123'
docker ps --format "{{.Names}} {{.Ports}}"
```

Fix — move our host port, never the container's:

```bash
ECU_PORT=3123 docker compose up -d   # client → http://localhost:3123/mcp
PORT=3123 bun src/http.ts            # local Bun route
```

## Chromium won't launch in Docker

- Keep `ipc: host` (Chromium crashes on small `/dev/shm` without it).
- Keep `init: true` (avoids PID-1 zombie processes).
- Headless only in containers. If you see sandbox errors on untrusted
  sites, run with a non-root user + seccomp profile per
  <https://playwright.dev/docs/docker> (trusted E2E code is fine as root).

## `bun: not found` during `docker build`

The `curl | bash` Bun installer can break mid-download (`curl: (56)`) yet
the layer still "succeeds", leaving no binary. The effing-use Dockerfile copies Bun from
the pinned `oven/bun` image instead — deterministic, no network flakiness:

```dockerfile
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
```

## Query extract returns `[]`

`page.locator(sel).evaluateAll(fn)` does **not** forward outer-scope args —
the second parameter must be passed explicitly:

```ts
.evaluateAll((els, m: string) => /* … */, mode)
```

Without it the callback receives `undefined` and (depending on arity
handling) the call throws inside the page, surfacing as an empty result
via `.catch(() => [])`. Lesson: always pass `evaluateAll`/`evaluate`
arguments explicitly; never rely on closure capture across the
browser boundary.

## Stale snapshot refs (`E_NOT_FOUND`)

Refs are nth-match positions in DOM order — any navigation or re-render
invalidates them. Fix: re-run `browser_observe kind: "snapshot"` and use
fresh `eN` values. Fuzzy matching (`fill` with a label) and `role=`
selectors survive re-renders better than raw `eN` refs.

## Slow external sites timing out

Default action timeout is 15s (`BROWSER_TIMEOUT_MS`). For slow demos,
either raise it or prefer `wait` with `text:` expectations over fixed
`ms:` sleeps. For deterministic E2E, serve a local fixture
(`file:///tmp/…`) instead of depending on the network.
