import type { Page } from "playwright";

type PageState = {
  dirty: boolean;
  baseline: string | null;
  baselineUrl: string | null;
};

const pageStates = new Map<string, PageState>();

function key(sessionId: string): string {
  return sessionId;
}

export function ensureState(sessionId: string): PageState {
  let s = pageStates.get(key(sessionId));
  if (!s) {
    s = { dirty: true, baseline: null, baselineUrl: null };
    pageStates.set(key(sessionId), s);
  }
  return s;
}

export function markDirty(sessionId: string): void {
  ensureState(sessionId).dirty = true;
}

export function markClean(sessionId: string): void {
  ensureState(sessionId).dirty = false;
}

export function setBaseline(
  sessionId: string,
  snapshot: string,
  url: string,
): void {
  const s = ensureState(sessionId);
  s.baseline = snapshot;
  s.baselineUrl = url;
  s.dirty = false;
}

export function getBaseline(sessionId: string): string | null {
  return ensureState(sessionId).baseline;
}

export function isDirty(sessionId: string): boolean {
  return ensureState(sessionId).dirty;
}

export function clearDelta(sessionId: string): void {
  pageStates.delete(key(sessionId));
}

export async function injectDirtyObserver(
  page: Page,
  sessionId: string,
): Promise<void> {
  try {
    await page.evaluate((sid) => {
      const w = window as unknown as {
        __effDirty?: boolean;
        __effSid?: string;
        __effObs?: MutationObserver;
      };
      w.__effDirty = false;
      w.__effSid = sid;
      if (w.__effObs) w.__effObs.disconnect();
      const obs = new MutationObserver(() => {
        w.__effDirty = true;
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      document.addEventListener(
        "input",
        () => {
          w.__effDirty = true;
        },
        true,
      );
      document.addEventListener(
        "change",
        () => {
          w.__effDirty = true;
        },
        true,
      );
      w.__effObs = obs;
    }, sessionId);
  } catch {
    // ignore injection failures (e.g. page not ready)
  }
}

export async function checkDirty(page: Page): Promise<boolean> {
  try {
    const d = await page.evaluate(
      () => (window as unknown as { __effDirty?: boolean }).__effDirty,
    );
    return Boolean(d);
  } catch {
    return true;
  }
}

export async function clearDirtyFlag(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      (window as unknown as { __effDirty?: boolean }).__effDirty = false;
    });
  } catch {
    /* ignore */
  }
}

export function computeDelta(
  baseline: string | null,
  current: string,
): { delta: string; unchanged: boolean } {
  if (!baseline) return { delta: current, unchanged: false };
  if (baseline === current) return { delta: "", unchanged: true };
  // Simple line diff: emit only changed lines with [changed] markers
  const baseLines = baseline.split("\n");
  const curLines = current.split("\n");
  const baseSet = new Set(baseLines);
  const changed = curLines.filter((l) => !baseSet.has(l));
  const unchangedCount = curLines.length - changed.length;
  if (changed.length === 0) return { delta: "", unchanged: true };
  const header = `…${unchangedCount} unchanged lines…`;
  const delta = [header, ...changed.map((l) => `[changed] ${l}`)].join("\n");
  return { delta, unchanged: false };
}
