import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { loadMobileConfig, type MobileConfig } from "../config.js";
import { MobileError, toEnvelope } from "../errors.js";
import {
  asJournalConfig,
  attach,
  getSession,
  journalFile,
  nextCallId,
  requireCdp,
} from "../session.js";
import { callWithRuntime } from "../page.js";
import { buildHar } from "../har.js";
import { cap, stamp, writeOut } from "../output.js";
import { appendCall } from "../journal.js";

export const EXTRACT = ["text", "html", "table", "query", "har"] as const;

type ExtractArgs = {
  kind: string;
  selector?: string;
  mode?: string;
  limit?: number;
  since?: string;
  sessionId?: string;
};

async function runExtract(
  args: ExtractArgs,
  cfg: MobileConfig,
): Promise<Record<string, unknown>> {
  const sid = args.sessionId ?? "default";
  const s = await getSession(cfg, sid);

  switch (args.kind) {
    case "text": {
      await attach(cfg, s);
      const res = await callWithRuntime<{ text: string }>(
        requireCdp(s),
        "text",
        [cfg.domCapChars],
      );
      const path = await writeOut(cfg, stamp("text", "txt"), res.text);
      const { text, truncated } = cap(res.text, cfg.outputMaxChars);
      return { ok: true, kind: "text", path, preview: text, truncated };
    }

    case "html": {
      await attach(cfg, s);
      const res = await callWithRuntime<{ html: string }>(
        requireCdp(s),
        "html",
        [cfg.domCapChars],
      );
      const path = await writeOut(cfg, stamp("page", "html"), res.html);
      const { text, truncated } = cap(res.html, cfg.outputMaxChars);
      return { ok: true, kind: "html", path, preview: text, truncated };
    }

    case "table": {
      await attach(cfg, s);
      const res = await callWithRuntime<{
        rows?: string[][];
        notFound?: boolean;
        badSelector?: string;
      }>(requireCdp(s), "table", [args.selector ?? "table"]);
      if (res.notFound) {
        throw new MobileError(
          "E_NOT_FOUND",
          `No table matches "${args.selector ?? "table"}".`,
          "Pass selector= with a CSS selector, or observe kind=snapshot.",
        );
      }
      if (res.badSelector) {
        throw new MobileError(
          "E_BAD_INPUT",
          `Bad selector: ${res.badSelector}`,
          "Fix the selector.",
        );
      }
      const rows = (res.rows ?? []).slice(
        0,
        args.limit && args.limit > 0 ? args.limit : 200,
      );
      return { ok: true, kind: "table", rows };
    }

    case "query": {
      await attach(cfg, s);
      if (!args.selector) {
        throw new MobileError(
          "E_BAD_INPUT",
          "query needs selector=.",
          "Pass a CSS selector.",
        );
      }
      const res = await callWithRuntime<Record<string, unknown>>(
        requireCdp(s),
        "query",
        [args.selector],
      );
      return { ok: true, kind: "query", selector: args.selector, ...res };
    }

    case "har": {
      const har = buildHar(s.network, s.webview?.url ?? "");
      const path = await writeOut(
        cfg,
        stamp("net", "har"),
        JSON.stringify(har, null, 2),
      );
      return {
        ok: true,
        kind: "har",
        path,
        entries: s.network.length,
        ...(s.capacitor?.capacitorHttp
          ? {
              caveat:
                "CapacitorHttp is enabled; natively-issued requests are absent.",
            }
          : {}),
      };
    }

    default:
      return {
        ok: false,
        code: "E_BAD_INPUT",
        message: `Unknown extract kind "${args.kind}".`,
        hint: `Valid: ${EXTRACT.join(", ")}.`,
      };
  }
}

export const extractTool = defineTool(
  {
    name: "mobile_extract",
    description:
      "Pull structured data out of the app: rendered text, HTML, table rows as JSON, or a CSS query as JSON. Large results go to a file path with a capped preview. kind=har writes the captured network ring as HAR 1.2. Prefer over snapshot for scraping.",
    schema: v.object({
      kind: v.picklist(EXTRACT),
      selector: v.optional(v.string()),
      mode: v.optional(v.string()),
      limit: v.optional(v.number()),
      since: v.optional(v.string()),
      sessionId: v.optional(v.string()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    const cfg = loadMobileConfig();
    const sid = (args as ExtractArgs).sessionId ?? "default";
    const kind = String((args as ExtractArgs).kind ?? "unknown");
    const t0 = Date.now();
    const s = await getSession(cfg, sid).catch(() => null);
    const callId = s ? nextCallId(s) : "";
    let result: Record<string, unknown>;
    try {
      result = await runExtract(args as ExtractArgs, cfg);
    } catch (e) {
      result = toEnvelope(e, { journal: journalFile(cfg, sid) });
    }
    if (callId) result.callId = callId;
    await appendCall(asJournalConfig(cfg), sid, {
      tool: "extract",
      key: kind,
      durationMs: Date.now() - t0,
      ok: result.ok !== false,
      code: typeof result.code === "string" ? result.code : undefined,
    }).catch(() => "");
    return tool.text(JSON.stringify(result));
  },
);
