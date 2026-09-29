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

/** URL the current baseline was captured on — forces mode:full after navigation (plan §5.1). */
export function getBaselineUrl(sessionId: string): string | null {
  return pageStates.get(key(sessionId))?.baselineUrl ?? null;
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
      // Attribute spam that never changes the snapshot's ref lines (class,
      // style, expand/animation state) used to mark every live SPA permanently
      // dirty — the cheap "unchanged" fast path never fired. Ignore those;
      // content changes still arrive via childList/characterData/input/change.
      const NOISE_ATTRS = [
        "class",
        "style",
        "aria-expanded",
        "data-state",
        "data-orientation",
        "data-scroll-state",
        "data-highlighted",
        "data-hovered",
        "data-dragging",
        "data-resizing",
        "data-index",
      ];
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") {
            const name = m.attributeName || "";
            if (NOISE_ATTRS.indexOf(name) !== -1) continue;
          }
          w.__effDirty = true;
          return;
        }
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
  const curSet = new Set(curLines);
  const changed = curLines.filter((l) => !baseSet.has(l));
  const removed = baseLines.filter((l) => !curSet.has(l));
  if (changed.length === 0 && removed.length === 0)
    return { delta: "", unchanged: true };
  const unchangedCount = curLines.length - changed.length;
  const header = `…${unchangedCount} unchanged lines…`;
  const delta = [
    header,
    ...changed.map((l) => `[changed] ${l}`),
    // plan §5.1: removed nodes are reported explicitly
    ...removed.map((l) => `[removed] ${l}`),
  ].join("\n");
  return { delta, unchanged: false };
}
