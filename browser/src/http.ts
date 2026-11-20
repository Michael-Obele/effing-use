#!/usr/bin/env bun
import { HttpTransport } from "@tmcp/transport-http";
import { server } from "./server.js";

const port = Number(process.env.PORT ?? 3123);

// Streamable HTTP transport (MCP spec). Serves the MCP endpoint at /mcp.
// No auth on local loopback; put a reverse proxy / tunnel in front for remote use.
// Bun-only: Bun.serve keeps this file dependency-free (no node:http shim).
const transport = new HttpTransport(server, { path: "/mcp" });

Bun.serve({
  port,
  hostname: "0.0.0.0",
  // Bun closes idle connections after 10s by default (idleTimeout), and the
  // timer applies even while a response is being streamed. The MCP
  // Streamable-HTTP SSE notification stream sits idle between server->client
  // messages, so Bun was killing it every ~10s and clients logged
  // "Error reading from async stream: terminated" on a loop until the
  // connection hard-failed. idleTimeout: 0 disables the idle close entirely
  // (safe: this server is meant for local loopback / private networks).
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, name: "effing-use" });
    }
    // Cheap CPU telemetry for "what is eating my machine" debugging.
    // No browser touch, no allocations beyond JSON — safe to poll.
    //   curl localhost:3123/metrics  -> per-tool timings + session idle age
    //   curl localhost:3123/debug    -> same + slow-call list
    if (url.pathname === "/metrics" || url.pathname === "/debug") {
      const { getTelemetry } = await import("./browser/session.js");
      const { VERSION } = await import("./config.js");
      const tele = getTelemetry() as Record<string, unknown>;
      if (url.pathname === "/metrics") {
        const calls = tele.calls as Record<
          string,
          { count: number; avgMs: number; maxMs: number }
        >;
        const lines = ["# effing-use tool timings"];
        for (const [k, s] of Object.entries(calls)) {
          lines.push(`tool_calls{op="${k}"} ${s.count}`);
          lines.push(`tool_avg_ms{op="${k}"} ${s.avgMs}`);
          lines.push(`tool_max_ms{op="${k}"} ${s.maxMs}`);
        }
        const sess = tele.sessions as Record<string, { idleSec: number }>;
        for (const [id, s] of Object.entries(sess)) {
          lines.push(`session_idle_sec{id="${id}"} ${s.idleSec}`);
        }
        lines.push(`browser_idle_sec ${(tele.browserIdleSec as number) ?? 0}`);
        lines.push(`browser_uptime_sec ${(tele.uptimeSec as number) ?? 0}`);
        return new Response(lines.join("\n") + "\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      return Response.json({
        ok: true,
        name: "effing-use",
        version: VERSION,
        ...tele,
      });
    }
    const response = await transport.respond(req);
    if (response === null) {
      return new Response("Not Found", { status: 404 });
    }
    return response;
  },
});

// eslint-disable-next-line no-console
console.log(`effing-use listening on :${port} (MCP at /mcp)`);
