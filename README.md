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

> [!IMPORTANT]
> **Not yet published.** Neither package is on npm or a container registry yet.
> `bunx --package effing-use …`, `bun install -g effing-use` and `docker pull`
> will fail until that is done — publishing both is planned for a later
> release. Until then, build and run from source (the Quick start below does
> this) or build the image locally with `docker compose … up --build`.

## Quick start

```bash
# Browser — Docker (recommended), from the repo root
docker compose -f browser/compose.yaml up --build -d     # :3123/mcp

# Browser — from source
cd browser && bun install
bunx playwright install chromium --only-shell
bun run start:http                                       # :3123/mcp

# Mobile — Docker daemon on :3130/mcp, from the repo root
adb kill-server && adb -a -P 5037 start-server           # host adb, all interfaces
MOBILE_PACKAGE=com.your.app docker compose -f mobile/compose.yaml up -d --build mobile-http

# Mobile — Docker stdio (container per client session)
MOBILE_PACKAGE=com.your.app docker compose -f mobile/compose.yaml run --rm -i mobile

# Mobile — from source, in your Capacitor project
bunx --package effing-use-mobile effing-use-mobile
```

Both speak MCP over stdio; the browser package also serves Streamable HTTP at
`http://localhost:3123/mcp` so several editors can share one Chromium. See
[`browser/README.md`](browser/README.md) and [`mobile/README.md`](mobile/README.md).

## Agent skills (optional)

Each package ships a `SKILL.md` — the loop, the ref rules and the failure codes,
written for the agent instead of for you. One command installs both with
[skills](https://github.com/vercel-labs/skills) (Node 22+, or `bunx skills`):

```bash
npx skills add Michael-Obele/effing-use --skill effing-use --skill effing-use-mobile
```

It writes `.agents/skills/` (read by Copilot, Codex, Cursor, Gemini CLI and
OpenCode) and symlinks `.claude/skills/` for Claude Code. Add `-g` for every
project instead of just this one. Or take one at a time:

```bash
npx skills add Michael-Obele/effing-use --skill effing-use          # browser
npx skills add Michael-Obele/effing-use --skill effing-use-mobile   # mobile
npx skills add Michael-Obele/effing-use --list                      # preview only
```

Both skills ship inside the npm tarballs, so a local install needs no network:

```bash
npx skills add ./node_modules/effing-use/skills/effing-use
npx skills add ./node_modules/effing-use-mobile/skills/effing-use-mobile
```

Or copy the folder by hand into `.agents/skills/` (project),
`~/.copilot/skills/` or `.claude/skills/`. The skill is documentation, not the
server — the MCP entry still has to exist before an agent can call anything.
Install the skill so it knows the loop; install the server so it can run it.

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
