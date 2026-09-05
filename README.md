# effing-use

Token-efficient browser control: 3 tools (`browser_act`, `browser_observe`, `browser_extract`) built with `tmcp` + Bun + Valibot + Playwright. Wraps Chromium with file-path-first outputs, capped snapshots, and high-level `goal`/`batch` actions.

- `tools/list` is ~3.9KB (3 tools) vs ~13.7KB for 21-tool Playwright MCP
- Snapshots capped at `OUTPUT_MAX_CHARS` (default 4000); full content saved under `.browser-use/`
- Screenshots/PDFs/traces returned as file paths, never inline base64

## Quick start

```bash
bun install
bunx playwright install chromium --only-shell
bun src/index.ts          # STDIO (single VS Code instance)
bun src/http.ts           # Streamable HTTP on :3000 (/mcp) — shared across instances
```

## Docker (shared across VS Code instances)

```bash
docker compose up --build -d
curl http://localhost:3000/healthz
```

Then point any local VS Code instance at `http://localhost:3000/mcp`
(see `.vscode/mcp.json` → `effing-use (http)`).
Plain HTTP on loopback is intentional — add TLS at the edge
(reverse proxy / Cloudflare Tunnel / Tailscale) for remote use.

## Client config (STDIO, no auth)

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "bun",
      "args": ["/path/to/litepilot/src/index.ts"]
    }
  }
}
```

## Tools

- `browser_act` — open/goto, click, fill, type, press, select, check, hover, drag, upload, scroll, back/forward/reload, wait, dialogs, tabs, resize, `goal`, `batch` (steps[])
- `browser_observe` — snapshot (e-refs), screenshot (path), url, title, console, network, tabs, focused
- `browser_extract` — text, html, table (JSON rows), query (text|href|json), pdf, trace_start/stop

## Workflow

1. `browser_observe` kind=snapshot → get `[eN]` refs
2. `browser_act` to interact (prefer `batch` for fill+press flows)
3. `browser_observe` kind=screenshot to verify
4. `browser_extract` kind=text|table|query to scrape

See `skills/effing-use/SKILL.md` for the installable agent skill (skills.sh-ready). Env defaults in `.env.example`.

## Verify

```bash
bunx tsc --noEmit   # 0 errors
bun test            # unit green
```
