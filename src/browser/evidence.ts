import type { Page } from "playwright";
import { getConsoleLogs, getNetworkLogs } from "./session.js";

export type Effect = {
  urlChanged: boolean;
  urlBefore?: string;
  urlAfter?: string;
  domChanged: string[];
  consoleErrors: string[];
  dialog?: string;
  networkFailures?: string[];
  mustObserve: boolean;
};

const EFFECT_MAX_CHARS_DEFAULT = 800;

function capEffect(effect: Effect, maxChars: number): Effect {
  // Hard cap 800 chars total — truncate domChanged/consoleErrors/networkFailures
  let total = JSON.stringify(effect).length;
  if (total <= maxChars) return effect;
  // Trim arrays until under cap
  while (total > maxChars && effect.domChanged.length > 0) {
    effect.domChanged.pop();
    total = JSON.stringify(effect).length;
  }
  while (total > maxChars && effect.consoleErrors.length > 0) {
    effect.consoleErrors.pop();
    total = JSON.stringify(effect).length;
  }
  while (total > maxChars && (effect.networkFailures?.length ?? 0) > 0) {
    effect.networkFailures!.pop();
    total = JSON.stringify(effect).length;
  }
  return effect;
}

export async function collectEffect(
  page: Page,
  sessionId: string,
  urlBefore: string,
  domBeforeHash: string | null,
  consoleBeforeLen: number,
  networkBeforeLen: number,
  maxChars = EFFECT_MAX_CHARS_DEFAULT,
): Promise<Effect> {
  const urlAfter = page.url();
  const urlChanged = urlBefore !== urlAfter;

  // domChanged: line-level diff of body.innerText (50k cap). v0.2 only
  // compared the first 200 chars, so any below-fold change looked like a no-op
  // (and fed the failure contract wrong "no DOM change" signals).
  let domChanged: string[] = [];
  try {
    const currentDom = await page.evaluate(
      () => document.body?.innerText?.slice(0, 50000) ?? "",
    );
    if (domBeforeHash !== null && currentDom !== domBeforeHash) {
      const before = new Set(
        domBeforeHash
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
      const after = currentDom
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const afterSet = new Set(after);
      const changed = after
        .filter((l) => !before.has(l))
        .slice(0, 5)
        .map((l) => l.slice(0, 140));
      const removed = [...before]
        .filter((l) => !afterSet.has(l))
        .slice(0, 3)
        .map((l) => `- ${l.slice(0, 138)}`);
      domChanged = [...changed, ...removed].slice(0, 5);
    }
  } catch {
    // ignore
  }

  const consoleLogs = getConsoleLogs(sessionId);
  const newConsole = consoleLogs.slice(consoleBeforeLen);
  const consoleErrors = newConsole
    .filter((c) => c.type === "error")
    .slice(-3)
    .map((c) => c.text.slice(0, 200));

  const networkLogs = getNetworkLogs(sessionId);
  const newNetwork = networkLogs.slice(networkBeforeLen);
  const networkFailures = newNetwork
    .filter((r) => r.status >= 400)
    .slice(-3)
    .map((r) => `${r.method} ${r.url.slice(0, 80)} → ${r.status}`);

  // dialog detection: check if page has dialog handler armed? For now undefined
  const effect: Effect = {
    urlChanged,
    ...(urlChanged ? { urlBefore, urlAfter } : {}),
    domChanged: domChanged.slice(0, 5),
    consoleErrors: consoleErrors.slice(0, 3),
    ...(networkFailures.length ? { networkFailures } : {}),
    mustObserve: false,
  };

  return capEffect(effect, maxChars);
}

const EXPECT_MAX_PATTERN = 200;

export function parseExpect(
  expect: string,
): { kind: string; pattern: string } | null {
  const s = expect.trim();
  let parsed: { kind: string; pattern: string } | null = null;
  if (s.startsWith("url~")) parsed = { kind: "url", pattern: s.slice(4) };
  else if (s.startsWith("text~"))
    parsed = { kind: "text", pattern: s.slice(5) };
  else if (s.startsWith("visible="))
    parsed = { kind: "visible", pattern: s.slice(8) };
  else if (s.startsWith("gone="))
    parsed = { kind: "gone", pattern: s.slice(5) };
  else return null;
  if (parsed.pattern.length > EXPECT_MAX_PATTERN) return null;
  // Validate regex patterns early for url~/text~
  if (parsed.kind === "url" || parsed.kind === "text") {
    try {
      new RegExp(parsed.pattern);
    } catch {
      return null;
    }
  }
  return parsed;
}

export async function evaluateExpect(
  page: Page,
  expect: string,
): Promise<{ ok: boolean; message?: string }> {
  const parsed = parseExpect(expect);
  if (!parsed) {
    return {
      ok: false,
      message: `Bad expect syntax "${expect}". Use url~<regex> | text~<regex> | visible=<css> | gone=<css>`,
    };
  }
  try {
    switch (parsed.kind) {
      case "url": {
        const re = new RegExp(parsed.pattern);
        const url = page.url();
        if (re.test(url)) return { ok: true };
        return {
          ok: false,
          message: `url "${url}" does not match /${parsed.pattern}/`,
        };
      }
      case "text": {
        const text = await page.innerText("body").catch(() => "");
        const slice = text.slice(0, 50000);
        const re = new RegExp(parsed.pattern);
        if (re.test(slice)) return { ok: true };
        return {
          ok: false,
          message: `page text does not match /${parsed.pattern}/`,
        };
      }
      case "visible": {
        const loc = page.locator(parsed.pattern);
        const count = await loc.count().catch(() => 0);
        if (count === 0)
          return {
            ok: false,
            message: `selector "${parsed.pattern}" not found`,
          };
        const visible = await loc
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) return { ok: true };
        return {
          ok: false,
          message: `selector "${parsed.pattern}" not visible`,
        };
      }
      case "gone": {
        const loc = page.locator(parsed.pattern);
        const count = await loc.count().catch(() => 0);
        if (count === 0) return { ok: true };
        const visible = await loc
          .first()
          .isVisible()
          .catch(() => false);
        if (!visible) return { ok: true };
        return {
          ok: false,
          message: `selector "${parsed.pattern}" still visible`,
        };
      }
      default:
        return { ok: false, message: `Unknown expect kind "${parsed.kind}"` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `expect evaluation failed: ${msg}` };
  }
}
