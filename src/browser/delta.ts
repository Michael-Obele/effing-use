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
  return diffSnapshot(
    stripHeader(baseline).join("\n"),
    stripHeader(current).join("\n"),
  );
}

/** Drop the `# url:` comment lines so a URL change isn't a node change. */
function stripHeader(s: string): string[] {
  return s.split("\n").filter((l) => l && !l.startsWith("# "));
}

/**
 * Snapshot lines look like `[e12] button "Delete"` (plus optional
 * aria/name/id/[checked] suffixes). The ref is a POSITION, not identity:
 * inserting one element at the top of a list renumbers every later ref, and a
 * naive line diff then reports the whole list as changed (measured: adding one
 * TodoMVC todo produced an 83% delta instead of the ~15% target, because the
 * two new buttons shifted refs +2).
 *
 * So diff on CONTENT (role + name + attrs), and report added/removed
 * occurrences as a multiset. Refs are re-emitted for added lines so the model
 * always has the current, valid ref for anything it has to act on.
 */
interface ParsedLine {
  ref: string;
  content: string;
}
const REF_RE = /^\[(e\d+)\]\s+(.*)$/;

function parse(lines: string[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const l of lines) {
    const m = REF_RE.exec(l);
    if (m) out.push({ ref: m[1], content: m[2] });
    else if (l) out.push({ ref: "", content: l });
  }
  return out;
}

function diffSnapshot(
  baseline: string,
  current: string,
): { delta: string; unchanged: boolean } {
  const cur = parse(current.split("\n"));
  const base = parse(baseline.split("\n"));

  // Multiset of contents so duplicate labels ("Pricing" x2) are handled.
  const baseCount = new Map<string, number>();
  for (const b of base)
    baseCount.set(b.content, (baseCount.get(b.content) ?? 0) + 1);

  const added: ParsedLine[] = [];
  const curCount = new Map<string, number>();
  for (const c of cur) {
    const seen = curCount.get(c.content) ?? 0;
    curCount.set(c.content, seen + 1);
    const had = baseCount.get(c.content) ?? 0;
    // First `had` occurrences match; any extra is new.
    if (seen >= had) added.push(c);
  }

  const baseSeen = new Map<string, number>();
  const removed: ParsedLine[] = [];
  for (const b of base) {
    const seen = baseSeen.get(b.content) ?? 0;
    baseSeen.set(b.content, seen + 1);
    const has = curCount.get(b.content) ?? 0;
    if (seen >= has) removed.push(b);
  }

  if (added.length === 0 && removed.length === 0)
    return { delta: "", unchanged: true };

  const unchangedCount = cur.length - added.length;
  const parts: string[] = [];
  if (unchangedCount > 0) parts.push(`…${unchangedCount} unchanged nodes…`);
  // Added lines carry their NEW ref so the model can act on them directly.
  // Ref-less lines (raw text diffs, e.g. unit fixtures) render as before.
  const fmt = (p: ParsedLine) =>
    p.ref ? `[${p.ref}] ${p.content}` : p.content;
  for (const a of added) parts.push(`[changed] ${fmt(a)}`);
  for (const r of removed) parts.push(`[removed] ${fmt(r)}`);

  // Ref renumbering: added nodes shift every later ref, so an action planned
  // against the old snapshot must re-observe. Say so once, cheaply.
  if (added.length > 0 && removed.length === 0 && added.length < cur.length) {
    parts.push("(refs shifted after this — re-observe before acting)");
  }

  return { delta: parts.join("\n"), unchanged: false };
}
