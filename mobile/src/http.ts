#!/usr/bin/env bun
import { HttpTransport } from "@tmcp/transport-http";
import { mobileServer } from "./server.js";
import { MOBILE_VERSION } from "./config.js";
import { listSessions } from "./session.js";

const port = Number(process.env.MOBILE_PORT ?? 3130);

/**
 * Streamable HTTP transport (MCP spec) at /mcp.
 *
 * The stdio entry (`index.ts`) is spawned per client and exits with it, which
 * is right for an editor but means the container cannot stay up. This entry is
 * the opposite trade: one long-lived process holding the adb forward and the
 * CDP socket, shared by every client that points at the port — the same shape
 * as the browser package, so both run as daemons under Docker.
 */
const transport = new HttpTransport(mobileServer, { path: "/mcp" });

Bun.serve({
  port,
  hostname: "0.0.0.0",
  // Bun closes idle connections after 10s by default, and the timer applies
  // even mid-stream. The MCP notification stream sits idle between messages,
  // so clients log "Error reading from async stream: terminated" every ~10s
  // until the connection hard-fails. 0 disables the idle close (this server is
  // for loopback / private networks).
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, name: "effing-use-mobile" });
    }
    // "Is my daemon actually attached to the phone?" — the first question when
    // a tool call fails, answerable without spending a tool call.
    if (url.pathname === "/debug") {
      return Response.json({
        ok: true,
        name: "effing-use-mobile",
        version: MOBILE_VERSION,
        sessions: listSessions(),
      });
    }
    const response = await transport.respond(req);
    if (response === null) return new Response("Not Found", { status: 404 });
    return response;
  },
});

console.log(`effing-use-mobile listening on :${port} (MCP at /mcp)`);
