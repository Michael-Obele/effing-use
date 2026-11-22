import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { loadMobileConfig, type MobileConfig } from "../config.js";
import { toEnvelope } from "../errors.js";
import {
  attach,
  asJournalConfig,
  getSession,
  journalFile,
  nextCallId,
  requireCdp,
  type MobileSession,
} from "../session.js";
import { callWithRuntime } from "../page.js";
import { logcat, screencap, shell } from "../adb.js";
import { cap, stamp, writeOut } from "../output.js";
import { computeDelta } from "../diff.js";
import {
  appendCall,
  formatEventLine,
  readJournal,
  summarizeErrors,
} from "../journal.js";

export const OBSERVE = [
  "snapshot",
  "screenshot",
  "url",
  "title",
  "console",
  "network",
  "errors",
  "logs",
  "plugins",
  "device",
  "apps",
  "state",
  "timeline",
] as const;

type ObserveArgs = {
  kind: string;
  target?: string;
  limit?: number;
  since?: string;
  filter?: string;
  sessionId?: string;
  inline?: boolean;
  mode?: "full" | "delta";
  scope?: string;
};

type SnapshotResult = {
  url: string;
  title: string;
  count: number;
  lines: string;
};

async function snapshot(
  cfg: MobileConfig,
  s: MobileSession,
  mode: "full" | "delta" | undefined,
): Promise<Record<string, unknown>> {
  const cdp = requireCdp(s);
  const snap = await callWithRuntime<SnapshotResult>(cdp, "snapshot", [
    { max: cfg.snapshotMax },
  ]);
  const full = [
    `# Snapshot — refs are per-snapshot: eN = Nth visible interactive element in DOM order.`,
    `# url: ${snap.url}`,
    `# title: ${snap.title}`,
    snap.lines || "(no interactive elements)",
  ].join("\n");

  let body = full;
  if (mode === "delta") {
    const d = computeDelta(s.baseline, full);
    if (d.unchanged) {
      // The whole point of the product: a re-observation after a no-op costs
      // about 20 tokens instead of a full tree. It still has to say WHERE it is
      // unchanged — an agent that sees `unchanged: true` and no url cannot tell
      // a quiet page from a silent navigation.
      return {
        ok: true,
        kind: "snapshot",
        mode: "delta",
        unchanged: true,
        count: snap.count,
        url: snap.url,
        title: snap.title,
      };
    }
    body = d.delta;
  }
  s.baseline = full;

  const { text, truncated } = cap(body, cfg.outputMaxChars);
  const out: Record<string, unknown> = {
    ok: true,
    kind: "snapshot",
    count: snap.count,
    url: snap.url,
    ...(mode === "delta" ? { mode: "delta" } : {}),
    snapshot: text,
    unchanged: false,
  };
  if (truncated) out.path = await writeOut(cfg, stamp("snapshot", "txt"), full);
  if (snap.count === 0) {
    out.looksEmpty = true;
    out.emptyHint =
      "No visible interactive elements. The UI may be canvas-rendered or still loading; try observe kind=screenshot.";
  }
  return out;
}

async function runObserve(
  args: ObserveArgs,
  cfg: MobileConfig,
): Promise<Record<string, unknown>> {
  const sid = args.sessionId ?? "default";
  const s = await getSession(cfg, sid);
  const jcfg = asJournalConfig(cfg);
  const limit = args.limit && args.limit > 0 ? args.limit : 20;

  switch (args.kind) {
    case "state": {
      // The zero-config entry point: attach if needed, and report why not when
      // attaching fails instead of throwing away the device facts we already have.
      let attachError: Record<string, unknown> | null = null;
      try {
        await attach(cfg, s);
      } catch (e) {
        attachError = toEnvelope(e);
      }
      const base: Record<string, unknown> = {
        ok: true,
        kind: "state",
        device: { serial: s.device.serial, model: s.device.model },
        app: {
          package: s.pkg,
          capacitor: s.capacitor
            ? {
                appId: s.capacitor.appId,
                config: s.capacitor.source,
                liveReload: s.capacitor.serverUrl ?? null,
                capacitorHttp: s.capacitor.capacitorHttp,
              }
            : null,
        },
        attached: !!s.cdp && !s.cdp.isClosed,
        baseline: s.baseline ? "have baseline" : "none",
        journal: journalFile(cfg, sid),
      };
      if (attachError) {
        base.attachError = attachError;
        return base;
      }
      const app = await callWithRuntime<Record<string, unknown>>(
        requireCdp(s),
        "state",
      ).catch(() => null);
      // Which window actually has focus, per the Android window manager.
      // The WebView is only one layer: an ANR dialog, a permission prompt, a
      // system update sheet or a keyboard-heavy overlay sits in front of it and
      // is invisible to CDP. Without this line the agent sees a healthy DOM and
      // a tap that "succeeded" with no visible change, and blames the app.
      const focus = await shell(
        s.device.serial,
        "dumpsys window | grep mCurrentFocus",
      ).catch(() => "");
      const focusText = focus.replace(/\s+/g, " ").trim();
      const window = /mCurrentFocus=Window\{[^}]*?\s(u0\s+)?([^}]+)\}/.exec(
        focusText,
      )?.[2];
      return {
        ...base,
        ...(app ?? {}),
        ...(window
          ? {
              focusedWindow: window,
              // Only a claim about occlusion, not about correctness: the
              // package name appears in the window title when the app owns
              // focus.
              appHasFocus: window.includes(s.pkg),
              ...(window.includes(s.pkg)
                ? {}
                : {
                    nativeOverlay:
                      "A native window has focus, not the app. WebView taps can still dispatch, but the user is looking at that window — use observe kind=screenshot to see it.",
                  }),
            }
          : {}),
      };
    }

    case "snapshot":
      await attach(cfg, s);
      return await snapshot(cfg, s, args.mode);

    case "screenshot": {
      const png = await screencap(s.device.serial);
      const path = await writeOut(cfg, stamp("shot", "png"), png);
      return { ok: true, kind: "screenshot", path, bytes: png.length };
    }

    case "url":
    case "title": {
      await attach(cfg, s);
      const st = await callWithRuntime<Record<string, unknown>>(
        requireCdp(s),
        "state",
      );
      return { ok: true, kind: args.kind, [args.kind]: st[args.kind] };
    }

    case "console": {
      const filter = args.filter?.toLowerCase();
      let lines = s.console;
      if (args.since) {
        const read = await readJournal(jcfg, sid, {
          type: ["console", "pageerror"],
          since: args.since,
          limit: limit * 5,
        });
        lines = read.events.map(formatEventLine);
      }
      if (filter) lines = lines.filter((l) => l.toLowerCase().includes(filter));
      const { text, truncated } = cap(
        lines.slice(-limit).join("\n"),
        cfg.outputMaxChars,
      );
      return {
        ok: true,
        kind: "console",
        count: lines.length,
        console: text,
        truncated,
      };
    }

    case "network": {
      const filter = args.filter?.toLowerCase();
      let entries = s.network;
      if (args.since) {
        const read = await readJournal(jcfg, sid, {
          type: ["response", "requestfailed"],
          since: args.since,
          limit: limit * 5,
        });
        entries = read.events.map((e) => ({
          method: String(e.method ?? "GET"),
          url: String(e.url ?? ""),
          status: typeof e.status === "number" ? e.status : undefined,
          error: typeof e.failure === "string" ? e.failure : undefined,
        }));
      }
      if (filter)
        entries = entries.filter((e) => e.url.toLowerCase().includes(filter));
      const out: Record<string, unknown> = {
        ok: true,
        kind: "network",
        count: entries.length,
        requests: entries.slice(-limit),
      };
      if (s.capacitor?.capacitorHttp) {
        out.caveat =
          "CapacitorHttp is enabled: fetch/XHR are executed natively, so this list misses those requests. Check observe kind=plugins for CapacitorHttp calls.";
      }
      return out;
    }

    case "errors": {
      const read = await readJournal(jcfg, sid, { limit: 1000 });
      const summary = summarizeErrors(read.events);
      return {
        ok: true,
        kind: "errors",
        ...summary,
        journal: read.path,
        truncated: read.truncated,
      };
    }

    case "logs": {
      const lines = await logcat(
        s.device.serial,
        s.webview?.pid ?? null,
        limit,
      );
      return { ok: true, kind: "logs", count: lines.length, lines };
    }

    case "plugins": {
      await attach(cfg, s);
      const res = await callWithRuntime<Record<string, unknown>>(
        requireCdp(s),
        "plugins",
      );
      return { ok: true, kind: "plugins", ...res };
    }

    case "device": {
      const [model, sdk, size, density, serial] = await Promise.all([
        shell(s.device.serial, "getprop ro.product.model").catch(() => ""),
        shell(s.device.serial, "getprop ro.build.version.sdk").catch(() => ""),
        shell(s.device.serial, "wm size").catch(() => ""),
        shell(s.device.serial, "wm density").catch(() => ""),
        Promise.resolve(s.device.serial),
      ]);
      return {
        ok: true,
        kind: "device",
        serial,
        model: model.trim(),
        sdk: sdk.trim(),
        size: size.replace(/\s+/g, " ").trim(),
        density: density.replace(/\s+/g, " ").trim(),
      };
    }

    case "apps": {
      const [all, running] = await Promise.all([
        shell(s.device.serial, "pm list packages -3").catch(() => ""),
        shell(s.device.serial, `pidof ${s.pkg}`).catch(() => ""),
      ]);
      const packages = all
        .replace(/\r/g, "")
        .split("\n")
        .map((l) => l.replace(/^package:/, "").trim())
        .filter(Boolean);
      return {
        ok: true,
        kind: "apps",
        app: s.pkg,
        running: running.trim() !== "",
        pid: running.trim() || null,
        packages: packages.slice(0, limit),
        total: packages.length,
      };
    }

    case "timeline": {
      const read = await readJournal(jcfg, sid, { limit: limit * 5 });
      const lines = read.events.slice(-limit).map(formatEventLine);
      const { text, truncated } = cap(lines.join("\n"), cfg.outputMaxChars);
      return {
        ok: true,
        kind: "timeline",
        total: read.total,
        timeline: text,
        truncated,
        journal: read.path,
      };
    }

    default:
      return {
        ok: false,
        code: "E_BAD_INPUT",
        message: `Unknown observe kind "${args.kind}".`,
        hint: `Valid: ${OBSERVE.join(", ")}.`,
      };
  }
}

export const observeTool = defineTool(
  {
    name: "mobile_observe",
    description:
      "Read app and device state without changing it: snapshot (element refs, or mode=delta for only what changed), screenshot (file path), url, title, console, network, errors, native logs, Capacitor plugin calls, device info, installed apps, session state, timeline. Snapshot before act to get refs; delta after an action costs ~20 tokens when nothing changed.",
    schema: v.object({
      kind: v.picklist(OBSERVE),
      target: v.optional(v.string()),
      limit: v.optional(v.number()),
      since: v.optional(v.string()),
      filter: v.optional(v.string()),
      sessionId: v.optional(v.string()),
      inline: v.optional(v.boolean()),
      mode: v.optional(v.picklist(["full", "delta"])),
      scope: v.optional(v.string()),
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
    const sid = (args as ObserveArgs).sessionId ?? "default";
    const kind = String((args as ObserveArgs).kind ?? "unknown");
    const t0 = Date.now();
    const s = await getSession(cfg, sid).catch(() => null);
    const callId = s ? nextCallId(s) : "";
    let result: Record<string, unknown>;
    try {
      result = await runObserve(args as ObserveArgs, cfg);
    } catch (e) {
      result = toEnvelope(e, { journal: journalFile(cfg, sid) });
    }
    if (callId) result.callId = callId;
    await appendCall(asJournalConfig(cfg), sid, {
      tool: "observe",
      key: kind,
      durationMs: Date.now() - t0,
      ok: result.ok !== false,
      code: typeof result.code === "string" ? result.code : undefined,
    }).catch(() => "");
    return tool.text(JSON.stringify(result));
  },
);
