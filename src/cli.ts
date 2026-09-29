#!/usr/bin/env bun
// CLI face — same engine via HTTP transport (model-agnostic).
// Usage: effing-use observe --kind snapshot --mode delta --session dev
//        effing-use act --action click --target e5 --expect 'url~/dashboard'
//        effing-use extract --kind state

const HELP = `effing-use CLI — same engine as MCP, over HTTP
Usage:
  effing-use observe --kind <snapshot|screenshot|url|title|console|network|tabs|focused> [--mode full|delta] [--scope <css>] [--session <id>]
  effing-use act --action <action> [--target <ref>] [--value <val>] [--expect <expr>] [--approve] [--session <id>]
  effing-use act --action batch --file steps.json
  effing-use extract --kind <text|html|table|query|pdf|trace_start|trace_stop|state> [--selector <css>] [--session <id>]
  effing-use --help

Env: EFFING_USE_URL (default http://localhost:3123/mcp)
`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else out[k] = true;
    }
  }
  return out;
}

async function main() {
  const [, , verb, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (!verb || args.help || verb === "--help" || verb === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const url = process.env.EFFING_USE_URL ?? "http://localhost:3123/mcp";
  // For CLI we call the HTTP MCP endpoint via JSON-RPC
  // Minimal client: POST tools/call
  const toolMap: Record<string, string> = {
    observe: "browser_observe",
    act: "browser_act",
    extract: "browser_extract",
  };
  const tool = toolMap[verb];
  if (!tool) {
    process.stderr.write(`Unknown verb "${verb}". Use observe|act|extract.\n`);
    process.exit(1);
  }

  // Build arguments object for the tool
  const toolArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "help") continue;
    // coerce
    if (k === "approve") toolArgs[k] = v === true || v === "true";
    else if (k === "limit") toolArgs[k] = Number(v);
    else toolArgs[k] = v;
  }
  // Map CLI names to tool schema names
  if (
    toolArgs.kind === undefined &&
    verb === "act" &&
    toolArgs.action === undefined
  ) {
    // allow --kind alias? no
  }
  // handle --file for batch
  if (toolArgs.file) {
    try {
      const raw = await Bun.file(String(toolArgs.file)).text();
      const steps = JSON.parse(raw);
      toolArgs.steps = Array.isArray(steps) ? steps : (steps.steps ?? []);
    } catch (e) {
      process.stderr.write(
        `Failed to read --file: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exit(1);
    }
    delete toolArgs.file;
  }
  // sessionId alias
  if (toolArgs.session && !toolArgs.sessionId) {
    toolArgs.sessionId = toolArgs.session;
    delete toolArgs.session;
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: toolArgs },
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body,
    });
  } catch {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        code: "E_NO_SERVER",
        message: `Cannot reach ${url}`,
        hint: "start: bun src/http.ts",
      }) + "\n",
    );
    process.exit(2);
  }

  if (!res.ok) {
    // Try to parse SSE or JSON
    const text = await res.text().catch(() => "");
    // SSE format: data: {...}
    const m = /data:\s*(\{.*\})/.exec(text);
    const payload = m ? m[1] : text;
    try {
      const j = JSON.parse(payload);
      const content =
        j.result?.content?.[0]?.text ?? j.error?.message ?? payload;
      // content is often JSON string of the tool result
      try {
        const inner = JSON.parse(content);
        process.stdout.write(JSON.stringify(inner) + "\n");
        process.exit(inner.ok === false ? 1 : 0);
      } catch {
        process.stdout.write(content + "\n");
        process.exit(0);
      }
    } catch {
      process.stderr.write(text + "\n");
      process.exit(1);
    }
  }

  const text = await res.text();
  // Handle SSE stream
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  const last = lines[lines.length - 1]?.slice(5).trim() ?? text;
  try {
    const j = JSON.parse(last);
    const content = j.result?.content?.[0]?.text ?? last;
    try {
      const inner = JSON.parse(content);
      process.stdout.write(JSON.stringify(inner) + "\n");
      process.exit(inner.ok === false ? 1 : 0);
    } catch {
      process.stdout.write(content + "\n");
      process.exit(0);
    }
  } catch {
    process.stdout.write(text + "\n");
    process.exit(0);
  }
}

main().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
