import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { loadMobileConfig, type MobileConfig } from "../config.js";
import { MobileError, toEnvelope } from "../errors.js";
import {
  getSession,
  attach,
  detach,
  journalFile,
  nextCallId,
  asJournalConfig,
  requireCdp as needCdp,
  type MobileSession,
} from "../session.js";
import { callWithRuntime } from "../page.js";
import {
  keyevent,
  launchApp,
  forceStop,
  shell,
  webviewSockets,
} from "../adb.js";
import type { Cdp } from "../cdp.js";
import { appendCall } from "../journal.js";

export const ACT = [
  "attach",
  "launch",
  "terminate",
  "reload",
  "open_url",
  "tap",
  "fill",
  "type",
  "press",
  "swipe",
  "scroll",
  "back",
  "wait",
  "deep_link",
  "permission",
  "orientation",
  "appearance",
  "eval",
  "note",
  "batch",
] as const;

export type ActArgs = {
  action: string;
  target?: string;
  value?: string;
  sessionId?: string;
  steps?: Array<{ action: string; target?: string; value?: string }>;
  expect?: string;
};

type Box = {
  stale?: boolean;
  notFound?: boolean;
  badSelector?: string;
  hit?: boolean;
  coveredBy?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tag: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a dispatched input to actually land.
 *
 * `Input.dispatchTouchEvent` resolves when the browser has queued the gesture,
 * not when the page has handled it: a snapshot taken right after a tap can read
 * the pre-tap DOM and answer `unchanged: true`, which reads as "your tap did
 * nothing". Two animation frames cover compositor -> main thread, and the small
 * sleep covers framework state updates that land a tick later (verified: a tap
 * that visibly worked was invisible to a delta 11 ms afterwards).
 */
async function settle(cdp: Cdp, cfg: MobileConfig): Promise<void> {
  await cdp
    .send("Runtime.evaluate", {
      expression:
        "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1)})})})",
      awaitPromise: true,
      returnByValue: true,
    })
    .catch(() => undefined);
  await sleep(cfg.settleMs);
}

// requireCdp is imported as needCdp: every action here needs the attached page.

const KEY_MAP: Record<string, { key: string; vk: number; text?: string }> = {
  enter: { key: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", vk: 9 },
  escape: { key: "Escape", vk: 27 },
  backspace: { key: "Backspace", vk: 8 },
  delete: { key: "Delete", vk: 46 },
  space: { key: " ", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", vk: 39 },
};

/** Resolve "e12" or a CSS selector to a screen point, scrolling it into view. */
async function point(cdp: Cdp, target: string): Promise<Box> {
  const ref = /^e(\d+)$/.exec(target.trim());
  const b = ref
    ? await callWithRuntime<Box>(cdp, "box", [Number(ref[1])])
    : await callWithRuntime<Box>(cdp, "domBox", [target]);
  if (b.stale) {
    throw new MobileError(
      "E_STALE",
      `Ref ${target} is stale — the element was replaced or removed.`,
      "observe kind=snapshot (or mode=delta), then use a fresh ref.",
    );
  }
  if (b.notFound) {
    throw new MobileError(
      "E_NOT_FOUND",
      `No element matches ${target}.`,
      "observe kind=snapshot to see what is on screen, or pass a CSS selector.",
    );
  }
  if (b.badSelector) {
    throw new MobileError(
      "E_BAD_INPUT",
      `Bad selector ${target}: ${b.badSelector}`,
      "Refs are eN from a snapshot; anything else is a CSS selector.",
    );
  }
  return b;
}

async function tapAt(cdp: Cdp, x: number, y: number): Promise<void> {
  const points = [{ x, y, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: points,
  });
  await sleep(20);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

/**
 * One-finger gesture. Touch (not mouse) because mobile UIs bind touch events —
 * Ionic ripples, `@touchend` handlers and native scroll only fire for touch.
 */
async function gesture(
  cdp: Cdp,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: Math.round(from.x + (to.x - from.x) * t),
          y: Math.round(from.y + (to.y - from.y) * t),
          radiusX: 2,
          radiusY: 2,
          force: 1,
        },
      ],
    });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

async function viewport(cdp: Cdp): Promise<{ w: number; h: number }> {
  const st = await callWithRuntime<{ viewport: { w: number; h: number } }>(
    cdp,
    "state",
  );
  return st.viewport ?? { w: 390, h: 844 };
}

async function waitForWebview(
  s: MobileSession,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sockets = await webviewSockets(s.device.serial).catch(() => []);
    if (sockets.length) return;
    await sleep(400);
  }
  throw new MobileError(
    "E_NO_WEBVIEW",
    `${s.pkg} started but exposed no debuggable WebView within ${timeoutMs}ms.`,
    "Confirm this is a debug build; Capacitor only enables WebView debugging in development.",
  );
}

async function runAct(
  args: ActArgs,
  cfg: MobileConfig,
): Promise<Record<string, unknown>> {
  const sid = args.sessionId ?? "default";
  const s = await getSession(cfg, sid);
  const target = args.target?.trim();

  switch (args.action) {
    case "attach": {
      if (s.cdp && !s.cdp.isClosed) await detach(cfg, s);
      await attach(cfg, s);
      return {
        ok: true,
        action: "attach",
        device: s.device.serial,
        app: s.pkg,
        webview: s.webview?.url,
        pid: s.webview?.pid,
      };
    }

    case "launch": {
      await launchApp(s.device.serial, s.pkg);
      await waitForWebview(s, cfg.timeoutMs);
      await attach(cfg, s);
      return {
        ok: true,
        action: "launch",
        app: s.pkg,
        webview: s.webview?.url,
      };
    }

    case "terminate": {
      await forceStop(s.device.serial, s.pkg);
      await detach(cfg, s);
      return { ok: true, action: "terminate", app: s.pkg };
    }

    case "reload": {
      const cdp = needCdp(s);
      s.baseline = null;
      await cdp
        .send("Page.reload", { ignoreCache: false })
        .catch(() => undefined);
      await sleep(300);
      await attach(cfg, s);
      return { ok: true, action: "reload" };
    }

    case "open_url": {
      if (!args.value)
        throw new MobileError(
          "E_BAD_INPUT",
          "open_url needs value=<url>.",
          "Pass value.",
        );
      const cdp = needCdp(s);
      await cdp.send("Runtime.evaluate", {
        expression: `location.assign(${JSON.stringify(args.value)})`,
      });
      return { ok: true, action: "open_url", url: args.value };
    }

    case "tap": {
      if (!target)
        throw new MobileError(
          "E_BAD_INPUT",
          "tap needs target=eN or a CSS selector.",
          "observe kind=snapshot first.",
        );
      const cdp = needCdp(s);
      const b = await point(cdp, target);
      await tapAt(cdp, b.x, b.y);
      await settle(cdp, cfg);
      return {
        ok: true,
        action: "tap",
        target,
        at: { x: b.x, y: b.y },
        tag: b.tag,
        // A covered tap still dispatched: say who took it rather than letting
        // the agent guess why nothing changed.
        ...(b.hit === false
          ? {
              hit: false,
              coveredBy: b.coveredBy,
              hint: `The touch landed on ${b.coveredBy}, not ${target}. Dismiss the overlay, or target it directly.`,
            }
          : {}),
      };
    }

    case "fill": {
      if (!target || args.value === undefined) {
        throw new MobileError(
          "E_BAD_INPUT",
          "fill needs target and value.",
          "target=eN, value=<text>.",
        );
      }
      const ref = /^e(\d+)$/.exec(target);
      if (!ref) {
        throw new MobileError(
          "E_BAD_INPUT",
          "fill takes a ref (eN), not a selector.",
          "observe kind=snapshot, then fill target=eN.",
        );
      }
      const cdp = needCdp(s);
      const res = await callWithRuntime<{
        stale?: boolean;
        ok?: boolean;
        value?: string;
      }>(cdp, "fill", [Number(ref[1]), args.value]);
      if (res.stale) {
        throw new MobileError(
          "E_STALE",
          `Ref ${target} is stale.`,
          "observe kind=snapshot for fresh refs.",
        );
      }
      return { ok: true, action: "fill", target, value: res.value };
    }

    case "type": {
      if (!target || args.value === undefined) {
        throw new MobileError(
          "E_BAD_INPUT",
          "type needs target and value.",
          "target=eN, value=<text>.",
        );
      }
      const cdp = needCdp(s);
      const ref = /^e(\d+)$/.exec(target);
      if (ref) {
        const b = await callWithRuntime<Box>(cdp, "focusBox", [Number(ref[1])]);
        if (b.stale)
          throw new MobileError(
            "E_STALE",
            `Ref ${target} is stale.`,
            "observe kind=snapshot for fresh refs.",
          );
        await tapAt(cdp, b.x, b.y);
      } else {
        const b = await point(cdp, target);
        await tapAt(cdp, b.x, b.y);
      }
      // insertText goes through the same path as a real keyboard, so React and
      // Ionic's value trackers see a trusted input.
      await cdp.send("Input.insertText", { text: args.value });
      await settle(cdp, cfg);
      return { ok: true, action: "type", target, chars: args.value.length };
    }

    case "press": {
      const name = (args.value ?? "enter").toLowerCase();
      const key = KEY_MAP[name];
      if (!key) {
        throw new MobileError(
          "E_BAD_INPUT",
          `Unknown key "${name}".`,
          `Use one of: ${Object.keys(KEY_MAP).join(", ")}`,
        );
      }
      const cdp = needCdp(s);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: key.key,
        windowsVirtualKeyCode: key.vk,
        nativeVirtualKeyCode: key.vk,
        ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: key.key,
        windowsVirtualKeyCode: key.vk,
        nativeVirtualKeyCode: key.vk,
      });
      await settle(cdp, cfg);
      return { ok: true, action: "press", key: key.key };
    }

    case "swipe": {
      const cdp = needCdp(s);
      const vp = await viewport(cdp);
      const cx = Math.round(vp.w / 2);
      const cy = Math.round(vp.h / 2);
      const distance =
        Number(args.value) > 0 ? Number(args.value) : Math.round(vp.h * 0.3);
      await gesture(
        cdp,
        { x: cx, y: cy + distance / 2 },
        { x: cx, y: cy - distance / 2 },
      );
      await settle(cdp, cfg);
      return { ok: true, action: "swipe", distance };
    }

    case "scroll": {
      const cdp = needCdp(s);
      const vp = await viewport(cdp);
      const dir = (args.value ?? "down").toLowerCase();
      const amount = Math.round(vp.h * 0.6);
      const cx = Math.round(vp.w / 2);
      const cy = Math.round(vp.h / 2);
      const half = amount / 2;
      const from =
        dir === "up"
          ? { x: cx, y: cy - half }
          : dir === "left"
            ? { x: cx + half, y: cy }
            : dir === "right"
              ? { x: cx - half, y: cy }
              : { x: cx, y: cy + half };
      const to =
        dir === "up"
          ? { x: cx, y: cy + half }
          : dir === "left"
            ? { x: cx - half, y: cy }
            : dir === "right"
              ? { x: cx + half, y: cy }
              : { x: cx, y: cy - half };
      await gesture(cdp, from, to, 10);
      await sleep(200);
      await settle(cdp, cfg);
      return { ok: true, action: "scroll", direction: dir, distance: amount };
    }

    case "back": {
      // App-level Back belongs to the activity, not the WebView: CDP key events
      // never reach it.
      await keyevent(s.device.serial, 4);
      return { ok: true, action: "back" };
    }

    case "wait": {
      const ms = Number(args.value);
      const duration =
        Number.isFinite(ms) && ms > 0 ? Math.min(ms, 30_000) : 500;
      await sleep(duration);
      return { ok: true, action: "wait", ms: duration };
    }

    case "deep_link": {
      if (!args.value)
        throw new MobileError(
          "E_BAD_INPUT",
          "deep_link needs value=<url>.",
          "Pass a scheme URL.",
        );
      await shell(
        s.device.serial,
        `am start -a android.intent.action.VIEW -d '${args.value.replace(/'/g, "'\\''")}'`,
      );
      return { ok: true, action: "deep_link", url: args.value };
    }

    case "permission": {
      const raw = args.value ?? "";
      const [mode, perm] = raw.split(":");
      if (!perm) {
        throw new MobileError(
          "E_BAD_INPUT",
          'permission needs value="grant:android.permission.CAMERA".',
          'Use mode grant|revoke plus a permission name, or "reset:" to reset all.',
        );
      }
      if (mode === "reset") {
        await shell(s.device.serial, `pm reset-permissions ${s.pkg}`);
        return { ok: true, action: "permission", mode: "reset" };
      }
      if (mode !== "grant" && mode !== "revoke") {
        throw new MobileError(
          "E_BAD_INPUT",
          `Unknown permission mode "${mode}".`,
          "Use grant or revoke.",
        );
      }
      await shell(s.device.serial, `pm ${mode} ${s.pkg} ${perm}`);
      return { ok: true, action: "permission", mode, permission: perm };
    }

    case "orientation": {
      const value = (args.value ?? "portrait").toLowerCase();
      const rotation = value.startsWith("land") ? 1 : 0;
      await shell(
        s.device.serial,
        `settings put system accelerometer_rotation 0; settings put system user_rotation ${rotation}`,
      );
      return { ok: true, action: "orientation", value };
    }

    case "appearance": {
      const value = (args.value ?? "dark").toLowerCase();
      const mode = value === "light" ? "no" : value === "auto" ? "auto" : "yes";
      await shell(s.device.serial, `cmd uimode night ${mode}`);
      return { ok: true, action: "appearance", value };
    }

    case "eval": {
      if (!cfg.allowEval) {
        throw new MobileError(
          "E_EVAL_OFF",
          "eval is disabled.",
          "Start the server with MOBILE_ALLOW_EVAL=1 to allow running JS in the app.",
        );
      }
      if (!args.value)
        throw new MobileError(
          "E_BAD_INPUT",
          "eval needs value=<javascript>.",
          "Pass an expression.",
        );
      const cdp = needCdp(s);
      const res = await cdp.send("Runtime.evaluate", {
        expression: args.value,
        returnByValue: true,
        awaitPromise: true,
      });
      const out = res as {
        result?: { value?: unknown };
        exceptionDetails?: unknown;
      };
      return {
        ok: true,
        action: "eval",
        value: out.result?.value,
        ...(out.exceptionDetails ? { exception: out.exceptionDetails } : {}),
      };
    }

    case "note": {
      return { ok: true, action: "note", note: args.value ?? "" };
    }

    case "batch": {
      const steps = args.steps ?? [];
      if (!steps.length) {
        throw new MobileError(
          "E_BAD_INPUT",
          "batch needs steps[].",
          "steps: [{action, target?, value?}]",
        );
      }
      const applied: Array<Record<string, unknown>> = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        // Ordered, not atomic: a failed step stops the run and reports where.
        const r = await runAct(
          {
            ...step,
            sessionId: sid,
            action: step.action === "batch" ? "note" : step.action,
          },
          cfg,
        ).catch((e) => toEnvelope(e, { journal: journalFile(cfg, sid) }));
        if (r.ok === false) {
          return { ok: false, action: "batch", failedAt: i, applied, ...r };
        }
        applied.push(r);
      }
      return { ok: true, action: "batch", applied: applied.length };
    }

    default:
      throw new MobileError(
        "E_BAD_INPUT",
        `Unknown action "${args.action}".`,
        `Valid: ${ACT.join(", ")}.`,
      );
  }
}

export const actTool = defineTool(
  {
    name: "mobile_act",
    description:
      "Drive the Android device and the app's WebView: attach/launch/terminate/reload, tap/fill/type/press/swipe/scroll, back, wait, open_url, deep_link, permission, orientation, appearance, eval, note, batch. Targets are snapshot refs (eN) or CSS selectors. Returns a short JSON effect summary.",
    schema: v.object({
      action: v.picklist(ACT),
      target: v.optional(v.string()),
      value: v.optional(v.string()),
      sessionId: v.optional(v.string()),
      steps: v.optional(
        v.array(
          v.object({
            action: v.picklist(ACT),
            target: v.optional(v.string()),
            value: v.optional(v.string()),
          }),
        ),
      ),
      expect: v.optional(v.string()),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args) => {
    const cfg = loadMobileConfig();
    const sid = (args as ActArgs).sessionId ?? "default";
    const action = String((args as ActArgs).action ?? "unknown");
    const t0 = Date.now();
    const s = await getSession(cfg, sid).catch(() => null);
    const callId = s ? nextCallId(s) : "";
    let result: Record<string, unknown>;
    try {
      result = await runAct(args as ActArgs, cfg);
    } catch (e) {
      result = toEnvelope(e, { journal: journalFile(cfg, sid) });
    }
    if (callId) result.callId = callId;
    await appendCall(asJournalConfig(cfg), sid, {
      tool: "act",
      key: action,
      durationMs: Date.now() - t0,
      ok: result.ok !== false,
      code: typeof result.code === "string" ? result.code : undefined,
    }).catch(() => "");
    return tool.text(JSON.stringify(result));
  },
);
