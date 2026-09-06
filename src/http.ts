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
