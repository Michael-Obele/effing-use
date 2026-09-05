import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { loadConfig } from "../config.js";
import { getPage, getContext } from "../browser/session.js";
import { doExtract, doQuery } from "../browser/engine.js";
import { EngineError } from "../browser/refs.js";

export const extractTool = defineTool(
  {
    name: "browser_extract",
    description:
      "Pull structured data out of the page: rendered text, HTML, table rows as JSON, CSS query as JSON, PDF file, or Playwright trace. Large results go to a file path with a capped preview. Prefer over snapshot for scraping.",
    schema: v.object({
      kind: v.picklist([
        "text",
        "html",
        "table",
        "query",
        "pdf",
        "trace_start",
        "trace_stop",
      ]),
      selector: v.optional(v.string()),
      mode: v.optional(v.string()),
      limit: v.optional(v.number()),
      sessionId: v.optional(v.string()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ kind, selector, mode, limit, sessionId }) => {
    const config = loadConfig();
    const sid = sessionId ?? "default";
    try {
      const page = await getPage(config, sid);
      const context = await getContext(config, sid);
      if (kind === "query") {
        if (!selector)
          return tool.text(
            JSON.stringify({ ok: false, code: "E_BAD_INPUT", message: "Missing selector.", hint: "Pass a CSS selector in selector and mode text|href|json." }),
          );
        const result = await doQuery(page, config, selector, mode ?? "text", limit ?? 50);
        return tool.text(JSON.stringify({ ok: true, kind, ...result }));
      }
      const result = await doExtract(page, config, kind, selector, limit, {
        context,
        sessionId: sid,
      });
      return tool.text(JSON.stringify({ ok: true, kind, ...result }));
    } catch (e) {
      if (e instanceof EngineError)
        return tool.text(JSON.stringify({ ok: false, code: e.code, message: e.message, hint: e.hint }));
      return tool.text(
        JSON.stringify({ ok: false, code: "E_BAD_INPUT", message: e instanceof Error ? e.message : String(e), hint: "Retry the extract call." }),
      );
    }
  },
);
