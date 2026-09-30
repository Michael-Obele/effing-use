import type { Page, BrowserContext } from "playwright";
import type { Config } from "../config.js";
import { EngineError, resolveLocator, stableSelectorFor } from "./refs.js";
import { cap, saveText, stamp } from "./output.js";
import {
  getConsoleLogs,
  getNetworkLogs,
  closeSession,
  getMustObserve,
  setMustObserve,
  clearMustObserve,
} from "./session.js";
import { collectEffect, evaluateExpect, parseExpect } from "./evidence.js";
import {
  getBaseline,
  getBaselineUrl,
  setBaseline,
  computeDelta,
  injectDirtyObserver,
  checkDirty,
  clearDirtyFlag,
  ensureState as ensureDeltaState,
} from "./delta.js";
import { appendAction, appendNote, readState } from "./state.js";
import {
  isRecording,
  captureStep,
  saveRecording,
  loadRecording,
  startRecording,
  stopRecording,
  getReplayCursor,
  setReplayCursor,
  clearReplayCursor,
} from "./record.js";
import { compileMacro, isIrreversible } from "./macro.js";
import {
  registerFingerprints,
  clearRegistry,
  getFingerprint,
  extractFingerprints as collectFingerprints,
} from "./identity.js";
import { ensureLoopbackBridge, inContainer } from "./bridge.js";

export type ActAction =
  | "open"
  | "goto"
  | "click"
  | "dblclick"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "hover"
  | "drag"
  | "upload"
  | "scroll"
  | "back"
  | "forward"
  | "reload"
  | "wait"
  | "dialog_accept"
  | "dialog_dismiss"
  | "close"
  | "goal"
  | "batch"
  | "tab_new"
  | "tab_select"
  | "tab_close"
  | "resize"
  | "note"
  | "record_start"
  | "record_stop"
  | "compile"
  | "replay";

export interface ActOpts {
  context?: BrowserContext;
  sessionId?: string;
  expect?: string;
  approve?: boolean;
}
export interface ObserveOpts {
  context?: BrowserContext;
  sessionId?: string;
  mode?: "full" | "delta";
  scope?: string;
}

function timeoutOf(config: Config): number {
  return config.timeoutMs;
}
async function liteState(page: Page): Promise<{ url: string; title: string }> {
  return { url: page.url(), title: await page.title().catch(() => "") };
}

/**
 * Navigate, transparently bridging loopback URLs when containerised.
 *
 * A dev server bound to 127.0.0.1 is unreachable from a Docker Desktop VM
 * (separate netns) and Vite >=6 rejects the `host.docker.internal` Host header
 * with 403. The bridge makes `http://localhost:5175` work verbatim — the app
 * needs NO vite.config change (see src/browser/bridge.ts). On a native run the
 * direct dial succeeds first and this is a single extra probe, no bridge.
 */
async function navigate(
  page: Page,
  rawUrl: string,
  timeout: number,
  config: Config,
): Promise<void> {
  let url = rawUrl;
  let port: number | null = null;
  let loopback = false;
  try {
    const u = new URL(rawUrl);
    loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
    if (loopback && (u.protocol === "http:" || u.protocol === "https:"))
      port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    /* not a URL — let goto produce the real parse error */
  }

  if (port && loopback && process.env.EFFING_NO_BRIDGE !== "1") {
    const br = await ensureLoopbackBridge(port, {
      disabled: process.env.EFFING_BRIDGE === "0",
      host: process.env.EFFING_BRIDGE_HOST || undefined,
    });
    if (br.bridged) {
      (page as unknown as Record<string, unknown>).__bridgedVia = br.via;
    } else if (
      br.reason &&
      br.reason !== "already-reachable" &&
      inContainer()
    ) {
      // Surface an actionable error instead of a bare ERR_CONNECTION_REFUSED.
      throw new EngineError(
        "E_LOCALHOST_UNREACHABLE",
        `Cannot reach ${rawUrl} from inside the container: the dev server binds 127.0.0.1 only and no host gateway answered on port ${port} (${br.reason}).`,
        inContainer()
          ? 'Add `extra_hosts: ["host.docker.internal:host-gateway"]` to the compose service, or run the server natively (`bun src/http.ts`), or open the app on a host that is published (0.0.0.0).'
          : "Start the dev server so it accepts connections from this machine.",
        { url: rawUrl, port },
      );
    }
  }

  // Slow real-world pages (duckduckgo, news sites with tracker scripts) miss a
  // 15s domcontentloaded deadline even though the page is fine and interactive.
  // Failing there wastes the whole turn, so on timeout check whether the
  // document actually arrived; if it did, proceed and flag it as a slow load
  // rather than reporting a false failure.
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /Timeout .* exceeded|TimeoutError|waiting until/i.test(
      msg,
    );
    if (!isTimeout) throw e;
    const arrived = await page
      .evaluate(() => {
        const r = document.readyState;
        return {
          readyState: r,
          nodes: document.getElementsByTagName("*").length,
          text: (document.body?.innerText ?? "").trim().length,
        };
      })
      .catch(() => null);
    const usable =
      arrived !== null &&
      arrived.readyState !== "loading" &&
      (arrived.nodes > 0 || arrived.text > 0);
    if (!usable) throw e;
    (page as unknown as Record<string, unknown>).__slowLoad = {
      url,
      readyState: arrived!.readyState,
      nodes: arrived!.nodes,
      textChars: arrived!.text,
    };
  }
}

/**
 * SPA navigations commit after the action returns (client router awaits data),
 * so evidence collected immediately can report urlChanged:false for a click
 * that DOES navigate (observed: kikitai "Try paste & read" → /read).
 * Brief settle: one tick, then a second if the URL moved.
 */
async function settleSpa(page: Page, action: string): Promise<void> {
  if (!["click", "dblclick", "press", "goal"].includes(action)) return;
  const u0 = page.url();
  await page.waitForTimeout(60);
  if (page.url() !== u0) await page.waitForTimeout(60);
}
function toEngineError(e: unknown, fallbackHint: string): EngineError {
  if (e instanceof EngineError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const isTimeout =
    /timeout|exceeded|waiting/i.test(msg) ||
    (e as { name?: string })?.name === "TimeoutError";
  return new EngineError(
    isTimeout ? "E_TIMEOUT" : "E_BAD_INPUT",
    msg,
    fallbackHint,
  );
}
const MUTATING = new Set<string>([
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
  "open",
  "goto",
  "resize",
  "goal",
  "tab_new",
  "tab_select",
  "tab_close",
]);
function isMutating(a: string): boolean {
  return MUTATING.has(a);
}

// ---------------------------------------------------------------- act
export async function doAct(
  page: Page,
  config: Config,
  action: ActAction,
  target?: string,
  value?: string,
  opts?: ActOpts,
): Promise<Record<string, unknown>> {
  const timeout = timeoutOf(config);
  const sid = opts?.sessionId ?? "default";

  // Per-action stash must never leak from a previous (possibly failed) act
  const pageBag = page as unknown as Record<string, unknown>;
  delete pageBag.__rebound;

  // Non-page meta actions (no mustObserve guard, no evidence)
  if (action === "note") {
    if (!value && !target)
      throw new EngineError(
        "E_BAD_INPUT",
        "Missing note text.",
        "Pass value with the note.",
      );
    const note = value ?? target ?? "";
    await appendNote(config, sid, note);
    return { noted: true, note: note.slice(0, 300) };
  }
  if (action === "record_start") {
    const name = (value ?? target ?? "recording").trim() || "recording";
    startRecording(sid, name);
    return { recording: true, name };
  }
  if (action === "record_stop") {
    const rec = stopRecording(sid);
    if (!rec)
      throw new EngineError(
        "E_BAD_INPUT",
        "No active recording.",
        "Call record_start first.",
      );
    const path = await saveRecording(config, rec.name, rec.steps as any);
    return { recording: false, name: rec.name, steps: rec.steps.length, path };
  }
  if (action === "compile") {
    const name = (value ?? target ?? "").trim();
    if (!name)
      throw new EngineError(
        "E_BAD_INPUT",
        "Missing macro name.",
        "Pass value with the recording name.",
      );
    const rec = await loadRecording(config, name).catch(() => {
      throw new EngineError(
        "E_NOT_FOUND",
        `No recording "${name}".`,
        "Call record_start/stop first.",
      );
    });
    const { tsPath, mdPath, warnings } = await compileMacro(
      config,
      name,
      rec.steps as any,
    );
    return {
      compiled: true,
      name,
      steps: rec.steps.length,
      tsPath,
      mdPath,
      warnings,
    };
  }
  if (action === "replay") {
    const name = (value ?? target ?? "").trim();
    if (!name)
      throw new EngineError(
        "E_BAD_INPUT",
        "Missing macro name.",
        "Pass value with the macro name.",
      );
    const rec = await loadRecording(config, name).catch(() => {
      throw new EngineError(
        "E_NOT_FOUND",
        `No recording "${name}".`,
        "Compile first or check name.",
      );
    });
    const approve = opts?.approve === true;
    // Plan §6.3: run benign steps, pause AT each approval-gated step, and keep
    // a cursor so approve:true resumes here instead of re-running the prefix.
    const stepsArr = rec.steps as any[];
    const start = getReplayCursor(sid, name) ?? 0;
    const results: any[] = [];
    for (let i = start; i < stepsArr.length; i++) {
      const s = stepsArr[i];
      if (isIrreversible(s) && !approve) {
        setReplayCursor(sid, name, i);
        const ran = i - start;
        return {
          ok: false,
          code: "E_APPROVAL_REQUIRED",
          message:
            `Step ${i + 1} requires approval (${s.op}).` +
            (ran > 0 ? ` Ran ${ran} prior step(s).` : ""),
          hint: "Re-run with approve:true to resume from this step.",
          step: i + 1,
          completed: results.length,
          description: `${s.op} ${s.target ?? ""}`,
        } as any;
      }
      try {
        // Replay the RESOLVED selector, not the raw e-ref. An e-ref is
        // positional within one snapshot; on replay the page is in a
        // different state, so `e2` hits an arbitrary element (measured: a
        // recorded /pricing click silently no-op'd with E_EXPECT). The
        // compiler already stores a standalone selector; use it, falling
        // back to the recorded target only when none was resolved.
        const replayTarget =
          (s.resolvedSelector as string | undefined) || s.target;
        const r = await doAct(
          page,
          config,
          s.op as ActAction,
          replayTarget,
          s.value === "«redacted»" ? undefined : s.value,
          { ...opts, expect: s.expect },
        );
        results.push({ ok: true, seq: s.seq, ...r });
      } catch (e) {
        clearReplayCursor(sid, name);
        const err = toEngineError(e, "Replay failed.");
        results.push({
          ok: false,
          seq: s.seq,
          code: err.code,
          message: err.message,
        });
        return { replayed: false, name, failSeq: s.seq, results } as any;
      }
    }
    clearReplayCursor(sid, name);
    return {
      replayed: true,
      name,
      steps: results.length,
      resumedFrom: start,
      results,
    } as any;
  }

  // Failure contract guard
  if (isMutating(action) && getMustObserve(sid)) {
    throw new EngineError(
      "E_MUST_OBSERVE",
      "Must observe before next mutation.",
      "Call browser_observe kind=snapshot first.",
      { mustObserve: true } as any,
    );
  }

  // Validate expect syntax early
  if (opts?.expect) {
    const parsed = parseExpect(opts.expect);
    if (!parsed)
      throw new EngineError(
        "E_BAD_EXPECT",
        `Bad expect "${opts.expect}".`,
        "Use url~<regex> | text~<regex> | visible=<css> | gone=<css>",
      );
  }

  const urlBefore = page.url();
  let domBefore: string | null = null;
  try {
    // Full innerText (50k cap) — evidence diffs need the whole page, not just
    // the first 200 chars (v0.2: below-fold changes looked like no-ops).
    domBefore = await page.evaluate(
      () => document.body?.innerText?.slice(0, 50000) ?? "",
    );
  } catch {
    domBefore = null;
  }
  const consoleBefore = getConsoleLogs(sid).length;
  const networkBefore = getNetworkLogs(sid).length;

  // Recording selector capture — resolve the portable selector (plan §6.2
  // tier order: id → name → ARIA → data-* → placeholder → text → role+name)
  // BEFORE the action runs. A click that navigates replaces the DOM, so
  // resolving afterwards looked up the old e-ref on the NEW page and returned
  // null, emitting a broken `page.locator("e2")` into the compiled macro.
  let preResolved: string | undefined;
  if (target && isRecording(sid) && isMutating(action)) {
    preResolved =
      (await stableSelectorFor(page, target, sid).catch(() => null)) ??
      undefined;
  }

  let result: Record<string, unknown>;
  let isTimeout = false;
  try {
    switch (action) {
      case "open":
      case "goto": {
        const url = value ?? target;
        if (!url)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing URL.",
            "Pass the URL in value (or target).",
          );
        await navigate(page, url, timeout, config);
        result = { ...(await liteState(page)) };
        break;
      }
      case "click": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target, sid);
        const button =
          (value as "left" | "middle" | "right" | undefined) ?? "left";
        await loc.click({ button, timeout });
        result = { ...(await liteState(page)) };
        if ((page as any).__rebound) {
          (result as any).rebound = true;
          delete (page as any).__rebound;
        }
        break;
      }
      case "dblclick": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target, sid);
        await loc.dblclick({ timeout });
        result = { ...(await liteState(page)) };
        break;
      }
      case "fill": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target, sid);
        await loc.fill(value ?? "", { timeout });
        result = { ...(await liteState(page)) };
        break;
      }
      case "type": {
        await page.keyboard.type(value ?? "", { delay: 0 });
        result = { ...(await liteState(page)) };
        break;
      }
      case "press": {
        if (!value)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing key.",
            "Pass a key like Enter, Tab, Escape in value.",
          );
        await page.keyboard.press(value);
        result = { ...(await liteState(page)) };
        break;
      }
      case "select": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass a select element ref in target.",
          );
        const loc = await resolveLocator(page, target, sid);
        await loc.selectOption(value ?? "", { timeout });
        result = { ...(await liteState(page)) };
        break;
      }
      case "check": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass a checkbox ref in target.",
          );
        const loc = await resolveLocator(page, target, sid);
        await loc.check({ timeout });
        result = { ...(await liteState(page)) };
        break;
      }
      case "uncheck": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass a checkbox ref in target.",
          );
        const loc = await resolveLocator(page, target, sid);
        await loc.uncheck({ timeout });
        result = { ...(await liteState(page)) };
        break;
      }
      case "hover": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target, sid);
        await loc.hover({ timeout });
        result = { ...(await liteState(page)) };
        break;
      }
      case "drag": {
        if (!target || !value)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing drag endpoints.",
            "Pass start ref in target and end ref in value.",
          );
        const start = await resolveLocator(page, target, sid);
        const end = await resolveLocator(page, value, sid);
        await start.dragTo(end, { timeout });
        result = { ...(await liteState(page)) };
        break;
      }
      case "upload": {
        const files = (value ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (files.length === 0)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing files.",
            "Pass comma-separated file paths in value.",
          );
        await page.setInputFiles("input[type=file]", files, { timeout });
        result = { ...(await liteState(page)), files };
        break;
      }
      case "scroll": {
        const dir = (target ?? "").toLowerCase();
        if (dir === "up") await page.mouse.wheel(0, -500);
        else if (dir === "down") await page.mouse.wheel(0, 500);
        else if (dir === "top")
          await page.evaluate(() => window.scrollTo(0, 0));
        else if (dir === "bottom")
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
          );
        else if (target) {
          const loc = await resolveLocator(page, target, sid);
          await loc.scrollIntoViewIfNeeded({ timeout });
        } else await page.mouse.wheel(0, 500);
        result = { ...(await liteState(page)) };
        break;
      }
      case "back":
        await page
          .goBack({ waitUntil: "domcontentloaded", timeout })
          .catch(() => null);
        result = { ...(await liteState(page)) };
        break;
      case "forward":
        await page
          .goForward({ waitUntil: "domcontentloaded", timeout })
          .catch(() => null);
        result = { ...(await liteState(page)) };
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout });
        result = { ...(await liteState(page)) };
        break;
      case "wait": {
        const t = target ?? "";
        const msMatch = /^ms:(\d+)$/.exec(t);
        if (msMatch) {
          await page.waitForTimeout(Number(msMatch[1]));
          result = { ...(await liteState(page)), waited: t };
          break;
        }
        const textMatch = /^text:(.+)$/.exec(t);
        if (textMatch) {
          await page.getByText(textMatch[1]).first().waitFor({ timeout });
          result = { ...(await liteState(page)), waited: t };
          break;
        }
        if (t) {
          const loc = await resolveLocator(page, t, sid);
          await loc.waitFor({ timeout });
          result = { ...(await liteState(page)), waited: t };
          break;
        }
        await page.waitForTimeout(500);
        result = { ...(await liteState(page)) };
        break;
      }
      case "dialog_accept":
        page.once("dialog", (d) => void d.accept(value));
        result = { armed: true };
        break;
      case "dialog_dismiss":
        page.once("dialog", (d) => void d.dismiss());
        result = { armed: true };
        break;
      case "resize": {
        const m = /^(\d+)x(\d+)$/.exec(value ?? "");
        if (!m)
          throw new EngineError(
            "E_BAD_INPUT",
            `Bad size "${value}".`,
            "Use WIDTHxHEIGHT, e.g. 1280x800.",
          );
        await page.setViewportSize({
          width: Number(m[1]),
          height: Number(m[2]),
        });
        result = { ...(await liteState(page)), viewport: value };
        break;
      }
      case "tab_new": {
        if (!opts?.context)
          throw new EngineError(
            "E_NO_PAGE",
            "No context.",
            "Retry the call; session context is attached server-side.",
          );
        const p = await opts.context.newPage();
        if (value ?? target)
          await p.goto((value ?? target)!, {
            waitUntil: "domcontentloaded",
            timeout,
          });
        result = {
          url: p.url(),
          tabs: opts.context.pages().map((x) => x.url()),
        };
        break;
      }
      case "tab_select": {
        if (!opts?.context)
          throw new EngineError(
            "E_NO_PAGE",
            "No context.",
            "Retry the call; session context is attached server-side.",
          );
        const i = Number(target ?? value ?? 0);
        const pages = opts.context.pages();
        if (!pages[i])
          throw new EngineError(
            "E_BAD_INPUT",
            `No tab at index ${i}.`,
            "Call browser_observe kind=tabs for the tab list.",
          );
        await pages[i].bringToFront();
        result = { url: pages[i].url() };
        break;
      }
      case "tab_close": {
        if (!opts?.context)
          throw new EngineError(
            "E_NO_PAGE",
            "No context.",
            "Retry the call; session context is attached server-side.",
          );
        const pages = opts.context.pages();
        const raw = target ?? value;
        const i = raw == null || raw === "" ? pages.length - 1 : Number(raw);
        if (!pages[i])
          throw new EngineError(
            "E_BAD_INPUT",
            `No tab at index ${i}.`,
            "Call browser_observe kind=tabs for the tab list.",
          );
        await pages[i].close();
        result = { closed: i, tabs: opts.context.pages().map((x) => x.url()) };
        break;
      }
      case "close":
        await closeSession(sid);
        clearRegistry(sid);
        result = { closed: true };
        break;
      case "goal":
        // Route through the normal post-action pipeline (guard, evidence,
        // dirty flag, recording) — v0.2 returned here and skipped all of it.
        result = {
          ...(await doGoal(page, config, value ?? target ?? "", opts)),
        };
        break;
      case "batch":
        throw new EngineError(
          "E_BAD_INPUT",
          "Use steps[] for batch.",
          "Pass steps[] array; the tool handler runs doBatch.",
        );
      default:
        throw new EngineError(
          "E_BAD_INPUT",
          `Unknown action "${action}".`,
          "See browser_act schema for valid actions.",
        );
    }
  } catch (e) {
    const err = toEngineError(
      e,
      "Retry with a fresh snapshot ref, or re-observe state.",
    );
    if (err.code === "E_TIMEOUT") {
      isTimeout = true;
      setMustObserve(sid, true);
    }
    throw err;
  }

  // Post-action: evidence, expect, state, dirty, recording
  let effect: any = undefined;
  if (isMutating(action)) {
    await settleSpa(page, action);
    effect = await collectEffect(
      page,
      sid,
      urlBefore,
      domBefore,
      consoleBefore,
      networkBefore,
      config.effectMaxChars,
    );
    // Failure contract: timeout with no DOM/URL change => mustObserve
    if (isTimeout && !effect.urlChanged && effect.domChanged.length === 0)
      setMustObserve(sid, true);
    // Expect evaluation
    if (opts?.expect) {
      const ev = await evaluateExpect(page, opts.expect);
      if (!ev.ok) {
        effect.mustObserve = false;
        throw new EngineError(
          "E_EXPECT",
          ev.message ?? "Expect failed.",
          "Check effect and re-plan.",
          { effect, expect: opts.expect } as any,
        );
      }
      (result as any).expect = "pass";
    }
    if (effect) {
      (result as any).effect = effect;
      if (effect.mustObserve) (result as any).mustObserve = true;
    }
    // Surface the loopback bridge once per navigation so the model (and the
    // user debugging "why can't it open localhost") can see the hop.
    const bridgedVia = (page as unknown as Record<string, unknown>)
      .__bridgedVia;
    if (bridgedVia) {
      (result as any).bridgedVia = bridgedVia;
      delete (page as unknown as Record<string, unknown>).__bridgedVia;
    }
    // A navigation that missed the deadline but produced a real document is
    // not a failure — say so, so the model knows the page may still be
    // settling (late CSS/fonts/images) rather than fully loaded.
    const slow = (page as unknown as Record<string, unknown>).__slowLoad;
    if (slow) {
      (result as any).slowLoad = slow;
      delete (page as unknown as Record<string, unknown>).__slowLoad;
    }
    // Mark dirty for delta
    ensureDeltaState(sid).dirty = true;
    try {
      await page.evaluate(() => {
        (window as any).__effDirty = true;
      });
    } catch {}
  }

  // Append to state ring
  const actionLine = `${action} ${target ?? ""} ${value ?? ""}`
    .trim()
    .slice(0, 120);
  await appendAction(
    config,
    sid,
    `${actionLine} -> ${effect ? JSON.stringify(effect).slice(0, 80) : "ok"}`,
  );

  // Recording capture — uses the selector resolved BEFORE the action, so a
  // navigating click still records a working standalone macro step.
  // Keyless ops (press/type/scroll/wait) have no target but ARE part of the
  // flow — they used to be dropped, producing empty macros.
  if (isRecording(sid) && isMutating(action)) {
    captureStep(
      sid,
      {
        op: action,
        target,
        value,
        expect: opts?.expect,
        resolvedSelector: preResolved ?? target,
        targetFingerprint: target ? getFingerprint(sid, target) : undefined,
      },
      config,
    );
  }

  return result;
}

// ---------------------------------------------------------------- goal

export async function doGoal(
  page: Page,
  config: Config,
  goal: string,
  opts?: ActOpts,
): Promise<Record<string, unknown>> {
  const g = goal.trim();
  // add-todo planner
  let m = /add\s+todo\s+(.+)/i.exec(g);
  if (m) {
    const text = m[1].replace(/^["']|["']$/g, "");
    const box = page
      .getByPlaceholder(/new\s*todo|what needs|add.*todo/i)
      .or(page.locator("input.new-todo, #new-todo, input[placeholder]"));
    if ((await box.count()) > 0) {
      await box.first().fill(text, { timeout: timeoutOf(config) });
      await page.keyboard.press("Enter");
      return { planned: "add-todo", ...(await liteState(page)) };
    }
    return {
      planned: "add-todo",
      ...(await liteState(page)),
      note: "No todo input found; fill the new-todo field manually.",
    };
  }
  // search planner: "search SITE for QUERY"
  m = /search\s+(.+?)\s+for\s+(.+)/i.exec(g);
  if (m) {
    const query = m[2].replace(/^["']|["']$/g, "");
    const box = page
      .getByRole("searchbox")
      .or(page.getByRole("textbox"))
      .or(
        page.locator("input[type=search], input[name=q], input[name=search]"),
      );
    if ((await box.count()) > 0) {
      await box.first().fill(query, { timeout: timeoutOf(config) });
      await page.keyboard.press("Enter");
      return { planned: "search", ...(await liteState(page)) };
    }
  }
  throw new EngineError(
    "E_GOAL_UNCLEAR",
    `Cannot plan goal "${g}".`,
    "Use explicit act calls instead.",
    {
      suggestedSteps: [
        { action: "open", value: "https://example.com" },
        { action: "click", target: "e0" },
        { action: "fill", target: "e1", value: "text" },
      ],
    },
  );
}

// ---------------------------------------------------------------- batch

export async function doBatch(
  page: Page,
  config: Config,
  steps: Array<{ action: ActAction; target?: string; value?: string }>,
  opts?: ActOpts,
): Promise<Record<string, unknown>> {
  if (steps.length > 20)
    throw new EngineError(
      "E_BAD_INPUT",
      "Too many steps (max 20).",
      "Split into smaller batches.",
    );
  const results: Array<Record<string, unknown>> = [];
  let failIndex: number | undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      const r = await doAct(page, config, s.action, s.target, s.value, opts);
      results.push({ ok: true, ...r });
    } catch (e) {
      const err = toEngineError(
        e,
        "Fix this step then re-run remaining steps.",
      );
      results.push({
        ok: false,
        code: err.code,
        message: err.message,
        hint: err.hint,
      });
      failIndex = i;
      break;
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return failIndex === undefined
    ? { results, okCount }
    : { results, okCount, failIndex };
}

// ---------------------------------------------------------------- observe

export async function doObserve(
  page: Page,
  config: Config,
  kind: string,
  target?: string,
  limit?: number,
  opts?: ObserveOpts,
): Promise<Record<string, unknown>> {
  const sessionId = opts?.sessionId ?? "default";
  switch (kind) {
    case "url":
      return { url: page.url() };
    case "title":
      return { title: await page.title().catch(() => ""), url: page.url() };
    case "snapshot": {
      const mode = (opts?.mode ?? (config.deltaDefault ? "delta" : "full")) as
        | "full"
        | "delta";
      const scope = opts?.scope;
      // Navigation forces a fresh full baseline (plan §5.1) and needs a settle
      // beat: SPA routes hydrate after the URL changes — snapshots taken too
      // early miss the header/nav entirely (observed on kikitai /read).
      const prevUrl = getBaselineUrl(sessionId);
      const urlChanged = prevUrl !== null && prevUrl !== page.url();
      const settleHydration = async () => {
        if (!urlChanged) return;
        await page
          .waitForLoadState("networkidle", { timeout: 1500 })
          .catch(() => {});
        await page.waitForTimeout(80);
      };
      // Scoped snapshot: only within selector
      let yaml: string;
      if (scope) {
        await settleHydration();
        yaml = await buildSnapshot(page, scope);
        const path = await saveText(config, stamp("snapshot", "yaml"), yaml);
        const { text, truncated } = cap(yaml, config.outputMaxChars);
        // Scoped refs are now GLOBAL (see buildSnapshot), so they are
        // interchangeable with a full snapshot. Register the full-page
        // fingerprints so identity validation/rebind works on a scoped ref.
        const fps = await collectFingerprints(page);
        registerFingerprints(sessionId, fps);
        clearMustObserve(sessionId);
        return {
          path,
          summary: text,
          truncated,
          url: page.url(),
          title: await page.title().catch(() => ""),
          scope,
          mode: "scoped",
        };
      }
      // Delta path
      if (mode === "delta") {
        const baseline = getBaseline(sessionId);
        // No baseline, or the page navigated since the baseline → forced full
        if (!baseline || urlChanged) {
          await settleHydration();
          yaml = await buildSnapshot(page);
          setBaseline(sessionId, yaml, page.url());
          await injectDirtyObserver(page, sessionId);
          // register fingerprints
          const fps = await collectFingerprints(page);
          registerFingerprints(sessionId, fps);
          const path = await saveText(config, stamp("snapshot", "yaml"), yaml);
          const { text, truncated } = cap(yaml, config.outputMaxChars);
          clearMustObserve(sessionId);
          return {
            path,
            summary: text,
            truncated,
            ...emptyHint(yaml),
            url: page.url(),
            title: await page.title().catch(() => ""),
            mode: "full",
          };
        }
        // Check dirty flag
        const dirty = await checkDirty(page).catch(() => true);
        if (!dirty) {
          clearMustObserve(sessionId);
          const last = getBaseline(sessionId) ?? "";
          return {
            unchanged: true,
            ...emptyHint(last),
            url: page.url(),
            title: await page.title().catch(() => ""),
            hint: "last snapshot still valid",
            mode: "delta",
          };
        }
        yaml = await buildSnapshot(page);
        const { delta, unchanged } = computeDelta(baseline, yaml);
        if (unchanged) {
          await clearDirtyFlag(page);
          clearMustObserve(sessionId);
          return {
            unchanged: true,
            ...emptyHint(baseline ?? ""),
            url: page.url(),
            title: await page.title().catch(() => ""),
            hint: "no changes",
            mode: "delta",
          };
        }
        setBaseline(sessionId, yaml, page.url());
        await clearDirtyFlag(page);
        await injectDirtyObserver(page, sessionId);
        const fps = await collectFingerprints(page);
        registerFingerprints(sessionId, fps);
        const { text: dtext, truncated } = cap(delta, config.outputMaxChars);
        clearMustObserve(sessionId);
        // A delta does NOT write a snapshot file: the model already has the
        // previous full snapshot, and `path` was being emitted twice (as both
        // `path` and `fullPath`) for the same string. Only a full observe
        // persists to disk. This is the plan's "scope, never compress" rule:
        // the in-context payload is smaller by construction.
        return {
          delta: dtext,
          truncated,
          ...emptyHint(yaml),
          url: page.url(),
          title: await page.title().catch(() => ""),
          mode: "delta",
        };
      }
      // Full mode
      await settleHydration();
      yaml = await buildSnapshot(page);
      setBaseline(sessionId, yaml, page.url());
      await injectDirtyObserver(page, sessionId);
      const fps2 = await collectFingerprints(page);
      registerFingerprints(sessionId, fps2);
      const path = await saveText(config, stamp("snapshot", "yaml"), yaml);
      const { text, truncated } = cap(yaml, config.outputMaxChars);
      clearMustObserve(sessionId);
      return {
        path,
        summary: text,
        truncated,
        url: page.url(),
        title: await page.title().catch(() => ""),
        mode: "full",
      };
    }
    case "screenshot": {
      const full = (target ?? "") === "full" || (target ?? "") === "";
      const filename = stamp("shot", "png");
      const { mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(config.outputDir, { recursive: true });
      const path = join(config.outputDir, filename);
      await page.screenshot({ path, fullPage: full });
      return { path, url: page.url() };
    }
    case "console": {
      const logs = getConsoleLogs(sessionId);
      const n = limit ?? 20;
      return { logs: logs.slice(-n) };
    }
    case "network": {
      const logs = getNetworkLogs(sessionId);
      const n = limit ?? 20;
      return { requests: logs.slice(-n) };
    }
    case "tabs": {
      const ctx = opts?.context ?? page.context();
      return { tabs: ctx.pages().map((p) => p.url()) };
    }
    case "focused": {
      const html = await page.evaluate(
        () => document.activeElement?.outerHTML?.slice(0, 2000) ?? "(none)",
      );
      const { text, truncated } = cap(html, config.outputMaxChars);
      return { focused: text, truncated };
    }
    default:
      throw new EngineError(
        "E_BAD_INPUT",
        `Unknown observe kind "${kind}".`,
        "Valid: snapshot, screenshot, url, title, console, network, tabs, focused.",
      );
  }
}

/**
 * Flag a snapshot that found NO interactive elements.
 *
 * effing-use reads the DOM, so a canvas-rendered UI, a remote desktop or an
 * Electron app with custom-painted controls produces a snapshot with nothing in
 * it. Without a signal the model reads `unchanged: true` and concludes the page
 * is blank, or worse, that its own action did nothing. This is the cheap,
 * honest nudge to escalate to `browser_extract kind=screenshot`.
 */
export function emptyHint(snapshot: string): Record<string, unknown> {
  if (!snapshot.includes("(no interactive elements)")) return {};
  return {
    looksEmpty: true,
    emptyHint:
      "No DOM controls found. The UI may be canvas-rendered, inside a shadow root, or an image. Use browser_extract kind=screenshot before concluding the page is blank.",
  };
}

async function buildSnapshot(page: Page, scope?: string): Promise<string> {
  const header = [
    "# Snapshot — refs are nth-match: eN = Nth match of (button, a, input, select, textarea, [role=button], [tabindex]) in DOM order.",
    `# url: ${page.url()}`,
  ].join("\n");
  // Returns [description, globalRef] pairs. With a scope we still number
  // against the WHOLE document so a scoped ref means the same element as the
  // same ref in a full snapshot — otherwise `scope:"nav"` hands out e0 for the
  // first nav link while e0 globally is some unrelated <section>, and the
  // model clicks the wrong element (observed: E_TIMEOUT on <section>).
  const items = await page.evaluate((scopeSel) => {
    const SEL = "button, a, input, select, textarea, [role=button], [tabindex]";
    const all = Array.prototype.slice.call(
      document.querySelectorAll(SEL),
    ) as Element[];
    const globalIndex = new Map<Element, number>();
    all.forEach((el, i) => globalIndex.set(el, i));

    const root = scopeSel ? document.querySelector(scopeSel) : document;
    if (!root) return [] as Array<[string, number]>;
    const els = [
      ...((root as Element).querySelectorAll?.(SEL) ?? []),
    ] as Element[];
    if (scopeSel && (root as Element).matches?.(SEL)) {
      els.unshift(root as Element);
    }
    return els.slice(0, 200).map((el) => {
      const tag = el.tagName.toLowerCase();
      let text = (el.textContent ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80);
      // Form controls carry no text — surface placeholder/label so refs stop
      // showing as `input ""`, and mark checked state (real state changes that
      // delta should surface).
      const input = el as HTMLInputElement;
      if (!text) {
        text = (
          input.placeholder ||
          (input.labels && input.labels[0]?.textContent) ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
      }
      const checked =
        (tag === "input" || tag === "select") && input.checked
          ? " [checked]"
          : "";
      const aria = el.getAttribute("aria-label") ?? "";
      const name = el.getAttribute("name") ?? "";
      const id = el.getAttribute("id") ?? "";
      const extra = [
        aria && `aria="${aria}"`,
        name && `name="${name}"`,
        id && `id="${id}"`,
      ]
        .filter(Boolean)
        .join(" ");
      return [
        `${tag} "${text}"${extra ? " " + extra : ""}${checked}`,
        // An element outside `all` (e.g. the scope root itself, if it is
        // inside another matched subtree) still needs a stable index; fall
        // back to its position in the document-order list we built.
        globalIndex.get(el) ?? -1,
      ] as [string, number];
    });
  }, scope ?? null);
  const lines = items.map(([line, idx]) => `[e${idx}] ${line}`);
  return `${header}\n${lines.join("\n") || "(no interactive elements)"}`;
}

// ---------------------------------------------------------------- extract

export async function doExtract(
  page: Page,
  config: Config,
  kind: string,
  selector?: string,
  limit?: number,
  opts?: ObserveOpts,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case "text": {
      const text = selector
        ? ((await page
            .locator(selector)
            .first()
            .innerText()
            .catch(() => "")) as string)
        : ((await page.innerText("body").catch(() => "")) as string);
      const path = await saveText(config, stamp("text", "txt"), text);
      const { text: preview, truncated } = cap(text, config.outputMaxChars);
      return { path, preview, truncated };
    }
    case "html": {
      const html = selector
        ? ((await page
            .locator(selector)
            .first()
            .evaluate((el) => el.outerHTML)
            .catch(() => "")) as string)
        : ((await page.content().catch(() => "")) as string);
      const path = await saveText(config, stamp("page", "html"), html);
      const { text: preview, truncated } = cap(html, config.outputMaxChars);
      return { path, preview, truncated };
    }
    case "table": {
      const rows = (await page
        .locator(selector ?? "table")
        .first()
        .evaluate((table: Element) =>
          [...table.querySelectorAll("tr")].map((tr) =>
            [...tr.querySelectorAll("th,td")].map((c) =>
              (c.textContent ?? "").trim(),
            ),
          ),
        )
        .catch(() => [] as string[][])) as string[][];
      const sliced = rows.slice(0, Math.min(limit ?? 100, 100));
      const text = JSON.stringify(sliced);
      const path = await saveText(
        config,
        stamp("table", "json"),
        JSON.stringify(sliced, null, 2),
      );
      const { text: preview, truncated } = cap(text, config.outputMaxChars);
      return { path, rows: sliced, rowCount: rows.length, preview, truncated };
    }
    case "query": {
      // Routed by the extract tool to doQuery(); unreachable here.
      throw new EngineError(
        "E_BAD_INPUT",
        "Use selector + mode for query.",
        "Pass a CSS selector in selector and mode text|href|json.",
      );
    }
    case "pdf": {
      const filename = stamp("page", "pdf");
      const { mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(config.outputDir, { recursive: true });
      const path = join(config.outputDir, filename);
      await page.pdf({ path }).catch(() => {
        throw new EngineError(
          "E_BAD_INPUT",
          "PDF failed (Chromium/headless required).",
          "Run headless Chromium; headed browsers may not support page.pdf.",
        );
      });
      return { path };
    }
    case "trace_start": {
      const ctx = opts?.context ?? page.context();
      const filename = stamp("trace", "zip");
      const { join } = await import("node:path");
      const path = join(config.outputDir, filename);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(config.outputDir, { recursive: true });
      await ctx.tracing.start({ screenshots: true, snapshots: true });
      (ctx as unknown as { __tracePath?: string }).__tracePath = path;
      return { started: true, path };
    }
    case "trace_stop": {
      const ctx = opts?.context ?? page.context();
      const saved =
        (ctx as unknown as { __tracePath?: string }).__tracePath ??
        `${config.outputDir}/trace.zip`;
      await ctx.tracing.stop({ path: saved });
      return { path: saved };
    }
    case "state": {
      const sid = opts?.sessionId ?? "default";
      const st = await readState(config, sid);
      const dirty = await checkDirty(page).catch(() => false);
      return {
        notes: st.notes,
        lastActions: st.lastActions,
        path: st.path,
        url: page.url(),
        dirty,
      };
    }
    default:
      throw new EngineError(
        "E_BAD_INPUT",
        `Unknown extract kind "${kind}".`,
        "Valid: text, html, table, query, pdf, trace_start, trace_stop, state.",
      );
  }
}

/** CSS query with text|href|json mode — kept separate so doExtract keeps the plan's 5-arg signature. */
export async function doQuery(
  page: Page,
  config: Config,
  selector: string,
  mode = "text",
  limit = 50,
): Promise<Record<string, unknown>> {
  const items = await page
    .locator(selector)
    .evaluateAll(
      (els: Element[], m: string) =>
        els.map((el) => {
          if (m === "href")
            return (
              (el as HTMLAnchorElement).href ?? el.getAttribute("href") ?? ""
            );
          if (m === "json")
            return {
              tag: el.tagName.toLowerCase(),
              text: (el.textContent ?? "").trim().slice(0, 200),
              html: el.outerHTML.slice(0, 500),
            };
          return (el.textContent ?? "").trim().slice(0, 500);
        }),
      mode,
    )
    .catch(() => [] as unknown[]);
  const sliced = (items as unknown[]).slice(0, limit);
  const text = JSON.stringify(sliced);
  const path = await saveText(
    config,
    stamp("query", "json"),
    JSON.stringify(sliced, null, 2),
  );
  const { text: preview, truncated } = cap(text, config.outputMaxChars);
  return {
    path,
    items: sliced,
    count: (items as unknown[]).length,
    preview,
    truncated,
  };
}
