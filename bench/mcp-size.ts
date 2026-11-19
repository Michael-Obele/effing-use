// Weigh another MCP server's `tools/list` without installing its client SDK.
//
//   bun bench/mcp-size.ts npx -y @mobilenext/mobile-mcp@latest
//   bun bench/mcp-size.ts bun src/index.ts
//
// It speaks newline-delimited JSON-RPC over stdio, does initialize ->
// notifications/initialized -> tools/list, and prints the byte size of the
// tools/list response. Run it from the repo root so relative bins resolve.
//
// Why this exists: a handshake is paid by every agent, every session. A server
// that needs 36 tools to say what 3 could say is charging rent before the first
// page loads.

const bin = process.argv[2];
const args = process.argv.slice(3);

if (!bin) {
  console.error("usage: bun bench/mcp-size.ts <command> [...args]");
  process.exit(2);
}

const proc = Bun.spawn([bin, ...args], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, NO_COLOR: "1" },
});

// Some servers do slow startup work (device discovery, driver install checks).
// Drain stderr in the background: an unread pipe fills and blocks the child.
void (async () => {
  const stderr = proc.stderr.getReader();
  while (!(await stderr.read()).done) {}
})();

function send(obj: unknown) {
  proc.stdin.write(JSON.stringify(obj) + "\n");
  proc.stdin.flush();
}

const decoder = new TextDecoder();
let buffer = "";
const reader = proc.stdout.getReader();

async function next(): Promise<any> {
  const nl = buffer.indexOf("\n");
  if (nl !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    return JSON.parse(line);
  }
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("timeout waiting for MCP response")),
      20000,
    ),
  );
  const read = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("server exited before responding");
      buffer += decoder.decode(value, { stream: true });
      const i = buffer.indexOf("\n");
      if (i !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        return JSON.parse(line);
      }
    }
  })();
  return await Promise.race([read, timeout]);
}

const started = Date.now();
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-size", version: "1.0.0" },
  },
});
const init = await next();
send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const list = await next();

const tools = list.result?.tools ?? [];
const perTool = tools
  .map((t: any) => ({
    name: t.name,
    bytes: Buffer.byteLength(JSON.stringify(t)),
  }))
  .sort((a: any, b: any) => b.bytes - a.bytes);

console.log(
  JSON.stringify(
    {
      server: `${bin} ${args.join(" ")}`.trim(),
      initBytes: Buffer.byteLength(JSON.stringify(init)),
      toolsListBytes: Buffer.byteLength(JSON.stringify(list)),
      toolsCount: tools.length,
      approxTokens: Math.round(Buffer.byteLength(JSON.stringify(list)) / 3.6),
      top5LargestTools: perTool.slice(0, 5),
      elapsedMs: Date.now() - started,
    },
    null,
    2,
  ),
);
proc.kill();
process.exit(0);
