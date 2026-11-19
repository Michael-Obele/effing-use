import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { loadConfig } from "../config.js";
import {
  getPage,
  getContext,
  recordCall,
  touchSession,
} from "../browser/session.js";
import { doExtract, doQuery } from "../browser/engine.js";
import { EngineError } from "../browser/refs.js";
import { appendCall, journalPath } from "../browser/journal.js";

type ExtractArgs = {
  kind: string;
  selector?: string;
  mode?: string;
  limit?: number;
  sessionId?: string;
  since?: string;
  filter?: string;
  offset?: number;
};

async function runExtract(
  args: ExtractArgs,
  config: ReturnType<typeof loadConfig>,
): Promise<Record<string, unknown>> {
  const { kind, selector, mode, limit, sessionId, since, filter, offset } =
    args;
  const sid = sessionId ?? "default";
  try {
    const page = await getPage(config, sid);
    const context = await getContext(config, sid);
    if (kind === "query") {
      if (!selector)
        return {
          ok: false,
          code: "E_BAD_INPUT",
          message: "Missing selector.",
          hint: "Pass a CSS selector in selector and mode text|href|json.",
          journal: journalPath(config, sid),
        };
      const result = await doQuery(
        page,
        config,
        selector,
        mode ?? "text",
        limit ?? 50,
      );
      return { ok: true, kind, ...result };
    }
    const result = await doExtract(page, config, kind, selector, limit, {
      context,
      sessionId: sid,
      since,
      filter,
      offset,
    });
    return { ok: true, kind, ...result };
  } catch (e) {
    if (e instanceof EngineError)
      return {
        ok: false,
        code: e.code,
        message: e.message,
        hint: e.hint,
        journal: journalPath(config, sid),
      };
    return {
      ok: false,
      code: "E_BAD_INPUT",
      message: e instanceof Error ? e.message : String(e),
      hint: "Retry the extract call.",
      journal: journalPath(config, sid),
    };
  }
}

export const extractTool = defineTool(
  {
    name: "browser_extract",
    description:
      "Pull structured data out of the page: rendered text, HTML, table rows as JSON, CSS query as JSON, PDF file, Playwright trace, or a chronological session timeline of calls and browser events. Large results go to a file path with a capped preview. Prefer over snapshot for scraping.",
    schema: v.object({
      kind: v.picklist([
        "text",
        "html",
        "table",
        "query",
        "pdf",
        "trace_start",
        "trace_stop",
        "state",
        "timeline",
      ]),
      selector: v.optional(v.string()),
      mode: v.optional(v.string()),
      limit: v.optional(v.number()),
      sessionId: v.optional(v.string()),
      since: v.optional(v.string()),
      filter: v.optional(v.string()),
      offset: v.optional(v.number()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args) => {
    // Telemetry in `finally` so success, expected errors, and throws are all
    // timed without touching the handler's control flow.
    const t0 = Date.now();
    const sid = (args as ExtractArgs).sessionId ?? "default";
    const key = String((args as ExtractArgs).kind ?? "unknown");
    try {
      const config = loadConfig();
      const result = await runExtract(args as ExtractArgs, config);
      await journalCall(config, sid, "extract", key, Date.now() - t0, result);
      return tool.text(JSON.stringify(result));
    } finally {
      recordCall("extract", key, Date.now() - t0, sid);
      touchSession(sid);
    }
  },
);

// Journal the call after the result is known. Journal I/O must never fail a tool
// call, so errors are swallowed.
async function journalCall(
  config: ReturnType<typeof loadConfig>,
  sid: string,
  toolName: "observe" | "extract",
  key: string,
  durationMs: number,
  result: Record<string, unknown>,
): Promise<void> {
  try {
    const ok = result.ok === true;
    const code = typeof result.code === "string" ? result.code : undefined;
    const url = typeof result.url === "string" ? result.url : undefined;
    const path = typeof result.path === "string" ? result.path : undefined;
    await appendCall(config, sid, {
      tool: toolName,
      key,
      durationMs,
      ok,
      ...(code ? { code } : {}),
      ...(url ? { url } : {}),
      ...(path ? { path } : {}),
    });
  } catch {
    // swallow: journaling never breaks a tool call
  }
}
