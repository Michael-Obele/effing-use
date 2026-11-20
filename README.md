# effing-use

Token-efficient MCP servers for driving software from an AI agent. Two packages,
one design: **three tools**, a small handshake, and deltas instead of re-reading
everything on each observation.

| Folder                 | Package             | Drives                                        | Runs as                    |
| ---------------------- | ------------------- | --------------------------------------------- | -------------------------- |
| [`browser/`](browser/) | `effing-use`        | headless Chromium, through Playwright         | Bun, Docker, stdio or HTTP |
| [`mobile/`](mobile/)   | `effing-use-mobile` | an Android/Capacitor WebView, through adb+CDP | Bun, Docker, stdio         |

Each folder is a complete package: its own `package.json`, lockfile, tests,
`Dockerfile`, `compose.yaml`, README and CHANGELOG. Nothing at the repo root is
needed to build or run either one.

## Quick start

```bash
# Browser — Docker (recommended), from the repo root
docker compose -f browser/compose.yaml up --build -d     # :3123/mcp

# Browser — from source
cd browser && bun install
bunx playwright install chromium --only-shell
bun run start:http                                       # :3123/mcp

# Mobile — Docker, from the repo root
adb kill-server && adb -a -P 5037 start-server           # host adb, all interfaces
docker compose -f mobile/compose.yaml build
MOBILE_PACKAGE=com.your.app docker compose -f mobile/compose.yaml run --rm -i mobile

# Mobile — from source, in your Capacitor project
bunx --package effing-use-mobile effing-use-mobile
```

Both speak MCP over stdio; the browser package also serves Streamable HTTP at
`http://localhost:3123/mcp` so several editors can share one Chromium. See
[`browser/README.md`](browser/README.md) and [`mobile/README.md`](mobile/README.md).

## Layout

```
browser/          effing-use          — Chromium over Playwright
  src/  tests/  skills/effing-use/
  Dockerfile  compose.yaml  package.json  bun.lock
mobile/           effing-use-mobile   — Android WebView over adb + CDP
  src/  tests/  skills/effing-use-mobile/
  Dockerfile  compose.yaml  package.json  bun.lock
bench/            token-cost benchmarks (talk to MCP over HTTP, no imports)
docs/             shared docs: findings, comparison, mobile notes, releasing
.github/          one release workflow per package: v* → browser, mobile-v* → mobile
```

## Tests

```bash
bun test                                        # both packages, from the repo root
cd browser && bunx tsc --noEmit && bun test     # browser only; live test: EFFING_LIVE_TEST=1
cd mobile  && bunx tsc --noEmit && bun test     # mobile only;  live test: MOBILE_LIVE_TEST=1
```

The root has no `package.json` on purpose — each folder installs its own
dependencies, and the Docker builds use that folder as their build context.

Docker images are the supported way to run either package: `browser/compose.yaml`
publishes `:3123`, and `mobile/compose.yaml` runs stdio against the host's adb
server.

## Docs

- [`docs/FINDINGS.md`](docs/FINDINGS.md) — measured token/speed results
- [`docs/COMPARISON.md`](docs/COMPARISON.md) — vs Playwright MCP, feature by feature
- [`docs/MOBILE.md`](docs/MOBILE.md) — what the mobile package verifies, and what it doesn't
- [`docs/RELEASING.md`](docs/RELEASING.md) — release tags for both packages

MIT.
