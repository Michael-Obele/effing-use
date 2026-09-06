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
    const response = await transport.respond(req);
    if (response === null) {
      return new Response("Not Found", { status: 404 });
    }
    return response;
  },
});

// eslint-disable-next-line no-console
console.log(`effing-use listening on :${port} (MCP at /mcp)`);
