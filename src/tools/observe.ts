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
import { doObserve } from "../browser/engine.js";
import { EngineError } from "../browser/refs.js";
import { appendCall, journalPath } from "../browser/journal.js";

type ObserveArgs = {
  kind: string;
  target?: string;
  limit?: number;
  sessionId?: string;
  inline?: boolean;
  mode?: "full" | "delta";
  scope?: string;
  since?: string;
  filter?: string;
  level?: string;
  offset?: number;
};

async function runObserve(
  args: ObserveArgs,
  config: ReturnType<typeof loadConfig>,
): Promise<Record<string, unknown>> {
  const {
    kind,
    target,
    limit,
    sessionId,
    mode,
    scope,
    since,
    filter,
    level,
    offset,
  } = args;
  const sid = sessionId ?? "default";
  try {
    const page = await getPage(config, sid);
    const context = await getContext(config, sid);
    const result = await doObserve(page, config, kind, target, limit, {
      context,
      sessionId: sid,
      mode: mode as "full" | "delta" | undefined,
      scope,
      since,
      filter,
      level,
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
      hint: "Retry the observe call.",
      journal: journalPath(config, sid),
    };
  }
}

export const observeTool = defineTool(
  {
    name: "browser_observe",
    description:
      'Read browser state without changing it: snapshot (element refs), screenshot (viewport by default, target "full" for full-page), url, title, console logs, network requests, error summaries, tab list, focused element. Console/network read the persisted session journal; use since/filter/level/offset to narrow. Snapshots are capped; full content is saved to a file path. Call snapshot before act to get refs.',
    schema: v.object({
      kind: v.picklist([
        "snapshot",
        "screenshot",
        "url",
        "title",
        "errors",
        "console",
        "network",
        "tabs",
        "focused",
      ]),
      target: v.optional(v.string()),
      limit: v.optional(v.number()),
      sessionId: v.optional(v.string()),
      inline: v.optional(v.boolean()),
      mode: v.optional(v.picklist(["full", "delta"])),
      scope: v.optional(v.string()),
      since: v.optional(v.string()),
      filter: v.optional(v.string()),
      level: v.optional(v.string()),
      offset: v.optional(v.number()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    // Telemetry in `finally` so success, expected errors, and throws are all
    // timed without touching the handler's control flow.
    const t0 = Date.now();
    const sid = (args as ObserveArgs).sessionId ?? "default";
    const key = String((args as ObserveArgs).kind ?? "unknown");
    try {
      const config = loadConfig();
      const result = await runObserve(args as ObserveArgs, config);
      await journalCall(config, sid, "observe", key, Date.now() - t0, result);
      return tool.text(JSON.stringify(result));
    } finally {
      recordCall("observe", key, Date.now() - t0, sid);
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
