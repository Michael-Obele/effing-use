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
import { doAct, doBatch, type ActAction } from "../browser/engine.js";
import { EngineError } from "../browser/refs.js";
import { appendCall, journalPath } from "../browser/journal.js";

export const ACT_ACTIONS = [
  "open",
  "goto",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "drag",
  "upload",
  "scroll",
  "back",
  "forward",
  "reload",
  "wait",
  "dialog_accept",
  "dialog_dismiss",
  "close",
  "goal",
  "batch",
  "tab_new",
  "tab_select",
  "tab_close",
  "resize",
  "note",
  "record_start",
  "record_stop",
  "compile",
  "replay",
] as const;

const StepSchema = v.object({
  action: v.picklist(ACT_ACTIONS),
  target: v.optional(v.string()),
  value: v.optional(v.string()),
});

type ActArgs = {
  action: (typeof ACT_ACTIONS)[number];
  target?: string;
  value?: string;
  sessionId?: string;
  steps?: Array<{ action: string; target?: string; value?: string }>;
  expect?: string;
  approve?: boolean;
};

async function runAct(
  args: ActArgs,
  config: ReturnType<typeof loadConfig>,
): Promise<Record<string, unknown>> {
  const { action, target, value, sessionId, steps, expect, approve } = args;
  const sid = sessionId ?? "default";
  try {
    const page = await getPage(config, sid);
    const context = await getContext(config, sid);
    const opts = { context, sessionId: sid, expect, approve };
    if (action === "batch") {
      if (!steps || steps.length === 0)
        return {
          ok: false,
          code: "E_BAD_INPUT",
          message: "Missing steps[].",
          hint: "Pass steps[] with up to 20 {action,target,value} entries.",
          journal: journalPath(config, sid),
        };
      const result = await doBatch(
        page,
        config,
        steps as Array<{
          action: ActAction;
          target?: string;
          value?: string;
        }>,
        opts,
      );
      const url = page.url();
      const title = await page.title().catch(() => "");
      return { ok: true, action, url, title, ...result };
    }
    const result = await doAct(
      page,
      config,
      action as ActAction,
      target,
      value,
      opts,
    );
    return { ok: true, action, ...result };
  } catch (e) {
    if (e instanceof EngineError)
      return {
        ok: false,
        code: e.code,
        message: e.message,
        hint: e.hint,
        ...(e.data ?? {}),
        journal: journalPath(config, sid),
      };
    return {
      ok: false,
      code: "E_BAD_INPUT",
      message: e instanceof Error ? e.message : String(e),
      hint: "Retry with fresh snapshot refs.",
      journal: journalPath(config, sid),
    };
  }
}

export const actTool = defineTool(
  {
    name: "browser_act",
    description:
      "Drive the browser: open/goto URLs, click, fill, type, press keys, select, check, hover, drag, upload, scroll, back/forward/reload, wait, dialogs, tabs, resize, or run a high-level goal or batch of steps. Targets accept snapshot e-refs (e12), role= selectors, or CSS. Returns a capped JSON summary; large state goes to a file path.",
    schema: v.object({
      action: v.picklist(ACT_ACTIONS),
      target: v.optional(v.string()),
      value: v.optional(v.string()),
      sessionId: v.optional(v.string()),
      steps: v.optional(v.array(StepSchema)),
      expect: v.optional(v.string()),
      approve: v.optional(v.boolean()),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    // Telemetry in `finally` so success, expected errors, and throws are all
    // timed without touching the handler's control flow.
    const t0 = Date.now();
    const sid = (args as ActArgs).sessionId ?? "default";
    const key = String((args as ActArgs).action ?? "unknown");
    try {
      const result = await runAct(args as ActArgs, loadConfig());
      await journalCall(sid, "act", key, Date.now() - t0, result);
      return tool.text(JSON.stringify(result));
    } finally {
      recordCall("act", key, Date.now() - t0, sid);
      touchSession(sid);
    }
  },
);

// Journal the call after the result is known. Journal I/O must never fail a tool
// call, so errors are swallowed.
async function journalCall(
  sid: string,
  toolName: "act" | "observe" | "extract",
  key: string,
  durationMs: number,
  result: Record<string, unknown>,
): Promise<void> {
  try {
    const config = loadConfig();
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
