import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { loadConfig } from "../config.js";
import { getPage, getContext } from "../browser/session.js";
import { doAct, doBatch, doGoal, type ActAction } from "../browser/engine.js";
import { EngineError } from "../browser/refs.js";

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
] as const;

const StepSchema = v.object({
  action: v.picklist(ACT_ACTIONS),
  target: v.optional(v.string()),
  value: v.optional(v.string()),
});

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
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ action, target, value, sessionId, steps }) => {
    const config = loadConfig();
    const sid = sessionId ?? "default";
    try {
      const page = await getPage(config, sid);
      const context = await getContext(config, sid);
      const opts = { context, sessionId: sid };
      if (action === "batch") {
        if (!steps || steps.length === 0)
          return tool.text(
            JSON.stringify({
              ok: false,
              code: "E_BAD_INPUT",
              message: "Missing steps[].",
              hint: "Pass steps[] with up to 20 {action,target,value} entries.",
            }),
          );
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
        return tool.text(
          JSON.stringify({ ok: true, action, url, title, ...result }),
        );
      }
      if (action === "goal") {
        const result = await doGoal(page, config, value ?? target ?? "", opts);
        return tool.text(JSON.stringify({ ok: true, action, ...result }));
      }
      const result = await doAct(
        page,
        config,
        action as ActAction,
        target,
        value,
        opts,
      );
      return tool.text(JSON.stringify({ ok: true, action, ...result }));
    } catch (e) {
      if (e instanceof EngineError)
        return tool.text(
          JSON.stringify({
            ok: false,
            code: e.code,
            message: e.message,
            hint: e.hint,
            ...(e.data ?? {}),
          }),
        );
      return tool.text(
        JSON.stringify({
          ok: false,
          code: "E_BAD_INPUT",
          message: e instanceof Error ? e.message : String(e),
          hint: "Retry with fresh snapshot refs.",
        }),
      );
    }
  },
);
