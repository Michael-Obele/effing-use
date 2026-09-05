import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { loadConfig } from "../config.js";
import { getPage, getContext } from "../browser/session.js";
import { doObserve } from "../browser/engine.js";
import { EngineError } from "../browser/refs.js";

export const observeTool = defineTool(
  {
    name: "browser_observe",
    description:
      "Read browser state without changing it: snapshot (element refs), screenshot (file path), url, title, console logs, network requests, tab list, focused element. Snapshots are capped; full content is saved to a file path. Call snapshot before act to get refs.",
    schema: v.object({
      kind: v.picklist([
        "snapshot",
        "screenshot",
        "url",
        "title",
        "console",
        "network",
        "tabs",
        "focused",
      ]),
      target: v.optional(v.string()),
      limit: v.optional(v.number()),
      sessionId: v.optional(v.string()),
      inline: v.optional(v.boolean()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ kind, target, limit, sessionId }) => {
    const config = loadConfig();
    const sid = sessionId ?? "default";
    try {
      const page = await getPage(config, sid);
      const context = await getContext(config, sid);
      const result = await doObserve(page, config, kind, target, limit, {
        context,
        sessionId: sid,
      });
      return tool.text(JSON.stringify({ ok: true, kind, ...result }));
    } catch (e) {
      if (e instanceof EngineError)
        return tool.text(JSON.stringify({ ok: false, code: e.code, message: e.message, hint: e.hint }));
      return tool.text(
        JSON.stringify({ ok: false, code: "E_BAD_INPUT", message: e instanceof Error ? e.message : String(e), hint: "Retry the observe call." }),
      );
    }
  },
);
