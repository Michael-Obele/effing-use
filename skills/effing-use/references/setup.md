# Setup — effing-use

## Prerequisites

- [Bun](https://bun.sh) 1.4+ (`bun --version`)
- Docker 29+ with Compose v2 (only for the container route)
- Chromium system deps — handled by `bunx playwright install chromium`
  locally, or baked into the `mcr.microsoft.com/playwright:v1.63.0-noble`
  base image in Docker.

## Option A — local Bun (single VS Code instance)

```bash
bun install
bunx playwright install chromium --only-shell
bun src/index.ts          # STDIO transport
bun src/http.ts           # Streamable HTTP on $PORT (default 3000), MCP at /mcp
```

VS Code `.vscode/mcp.json`:

```json
{
  "servers": {
    "effing-use (stdio)": {
      "type": "stdio",
      "command": "bun",
      "args": ["${workspaceFolder}/src/index.ts"],
      "cwd": "${workspaceFolder}",
      "env": {
        "BROWSER_HEADLESS": "true",
        "OUTPUT_DIR": "${workspaceFolder}/.browser-use"
      }
    },
    "effing-use (http)": { "type": "http", "url": "http://localhost:3123/mcp" }
  }
}
```

## Option B — Docker (shared across VS Code instances)

```bash
ECU_PORT=3123 docker compose up --build -d
curl http://localhost:3123/healthz   # {"ok":true,"name":"effing-use"}
```

Then point any local client at `http://localhost:<ECU_PORT>/mcp`.
The container listens on 3000 internally; only the host-side port moves.

- `restart: unless-stopped` — survives daemon restarts and host reboots
  once started with `up -d`.
- `init: true` + `ipc: host` — Playwright's recommended flags (no PID-1
  zombies, no Chromium `/dev/shm` crashes).
- `.browser-use/` is bind-mounted so snapshots/screenshots land on the host.
- Plain HTTP on loopback is intentional. For remote use, terminate TLS at
  the edge (reverse proxy, Cloudflare Tunnel, Tailscale) — never bake certs
  into the image.

## Environment

All optional; defaults shown (see `.env.example`):

| Var                    | Default        | Notes                                          |
| ---------------------- | -------------- | ---------------------------------------------- |
| `PORT`                 | `3000`         | `src/http.ts` listen port (container-internal) |
| `ECU_PORT`             | `3000`         | compose host-side port override                |
| `BROWSER_HEADLESS`     | `true`         | Docker supports headless Chromium only         |
| `BROWSER_VIEWPORT_W/H` | `1280/800`     |                                                |
| `BROWSER_TIMEOUT_MS`   | `15000`        | per-action Playwright timeout                  |
| `OUTPUT_DIR`           | `.browser-use` | all file outputs land here                     |
| `OUTPUT_MAX_CHARS`     | `4000`         | inline cap; full text goes to the file         |
| `ALLOW_EVAL`           | `false`        | no raw JS eval path unless explicitly enabled  |

## Gitignore contract

`.browser-use/`, `*.png`, `*.pdf`, `node_modules/` stay out of git.
The local planning folder (`litepilot/docs/plan/`) is also gitignored —
it holds the build spec, not shippable code.

## Verify

```bash
bunx tsc --noEmit   # 0 errors
bun test            # unit green
curl -s -X POST http://localhost:3123/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 300
```
