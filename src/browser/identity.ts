import type { Page } from "playwright";

export type Fingerprint = {
  role: string;
  accessibleName: string;
  textHash: string;
  box: { x: number; y: number; w: number; h: number };
  pathHash: string;
};

/** Raw per-element data as extracted inside the page (before normalization). */
export type RawFp = {
  role: string;
  accessibleName: string;
  text: string;
  pathHash: string;
  box: { x: number; y: number; w: number; h: number };
};

/**
 * Browser-side fingerprint extractor — SINGLE SOURCE OF TRUTH shared by
 * snapshot registration, stale-ref validation and rebind search. Serialized
 * into the page as a string so it never closes over module scope.
 *
 * v0.2 bug fixed here: fingerprints used tag-name roles ("input"), aria-label
 * only, and own textContent (always "" for form controls), so every bare
 * checkbox shared one identity — rebind then clicked the wrong element
 * (TodoMVC: stale item toggle rebound to toggle-all). Now:
 * - role: implicit ARIA role (input[type=checkbox] → "checkbox")
 * - accessibleName: aria-label → <label> → alt → title → placeholder → text
 * - textHash: own text, else contextual text (nearest li/label/td/row), else
 *   placeholder — so item toggles carry their todo text
 */
export const RAW_FP_SCRIPT = `(() => {
  const SEL = "button, a, input, select, textarea, [role=button], [tabindex]";
  const norm = (s) => (s || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  const implicitRole = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "hidden") return "hidden";
      return "textbox";
    }
    return tag;
  };
  const accName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return norm(aria);
    if (el.labels && el.labels.length > 0) {
      const t = norm(el.labels[0].textContent);
      if (t) return t;
    }
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return norm(alt);
    const title = el.getAttribute("title");
    if (title && title.trim()) return norm(title);
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return norm(ph);
    return norm(el.textContent);
  };
  const textOf = (el) => {
    const own = norm(el.textContent);
    if (own) return own;
    const ctx = el.closest && el.closest("li, label, td, [role=listitem], [role=row]");
    if (ctx) {
      const t = norm(ctx.textContent);
      if (t) return t;
    }
    return norm(el.getAttribute("placeholder"));
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && parts.length < 6) {
      parts.push(cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    return parts.join(">");
  };
  const els = Array.prototype.slice.call(document.querySelectorAll(SEL), 0, 200);
  return els.map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      role: implicitRole(el),
      accessibleName: accName(el),
      text: textOf(el),
      pathHash: pathOf(el),
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    };
  });
})()`;

/** Extract fingerprints for every snapshot-visible element, as e-refs. */
export async function extractFingerprints(
  page: Page,
): Promise<Array<{ ref: string; fp: Fingerprint }>> {
  const raw = (await page
    .evaluate(RAW_FP_SCRIPT)
    .catch(() => [] as RawFp[])) as RawFp[];
  return raw.map((r, i) => ({ ref: `e${i}`, fp: buildFingerprint(r) }));
}

function hashText(s: string): string {
  return s.trim().replace(/\s+/g, " ").slice(0, 80);
}

function boxKey(box: { x: number; y: number; w: number; h: number }): string {
  return `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.w)}:${Math.round(box.h)}`;
}

// Per-session registry: sessionId -> Map<ref, Fingerprint>
const registry = new Map<string, Map<string, Fingerprint>>();

export function registerFingerprints(
  sessionId: string,
  entries: Array<{ ref: string; fp: Fingerprint }>,
): void {
  let m = registry.get(sessionId);
  if (!m) {
    m = new Map();
    registry.set(sessionId, m);
  }
  // Never recycle within session — but allow overwrite on fresh snapshot
  for (const { ref, fp } of entries) m.set(ref, fp);
}

export function getFingerprint(
  sessionId: string,
  ref: string,
): Fingerprint | undefined {
  return registry.get(sessionId)?.get(ref);
}

export function clearRegistry(sessionId: string): void {
  registry.delete(sessionId);
}

export type RebindCandidate = { index: number; fp: Fingerprint };

/**
 * Conservative rebind ladder (P0 fix): pick an element only when the match is
 * UNAMBIGUOUS — never guess among equals.
 *
 * 1. loose match (role + accessibleName + textHash) — unique → take it
 * 2. multiple loose → narrow by identical pathHash; still >1 → give up
 * 3. no loose → fuzzy (role + name/text contains) under the same rules
 *
 * Returns the chosen candidate index, or null when zero or more than one
 * candidate survives — callers turn null into E_STALE (fail loud) instead of
 * clicking the wrong element.
 */
export function chooseRebindIndex(
  expected: Fingerprint,
  candidates: RebindCandidate[],
): number | null {
  const narrow = (pool: RebindCandidate[]): number | null => {
    if (pool.length === 1) return pool[0].index;
    if (pool.length > 1 && expected.pathHash) {
      const byPath = pool.filter((c) => c.fp.pathHash === expected.pathHash);
      if (byPath.length === 1) return byPath[0].index;
    }
    return null;
  };
  const loose = candidates.filter((c) => looseMatch(expected, c.fp));
  if (loose.length > 0) return narrow(loose);
  const fuzzy = candidates.filter((c) => fuzzyMatch(expected, c.fp));
  return narrow(fuzzy);
}

export function fingerprintEquals(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.role === b.role &&
    a.accessibleName === b.accessibleName &&
    a.textHash === b.textHash &&
    boxKey(a.box) === boxKey(b.box) &&
    a.pathHash === b.pathHash
  );
}

// Loose match for rebind: role + name + textHash (ignore box/path)
export function looseMatch(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.role === b.role &&
    a.accessibleName === b.accessibleName &&
    a.textHash === b.textHash
  );
}

export function fuzzyMatch(a: Fingerprint, b: Fingerprint): boolean {
  // fuzzy: role must match, and either name or textHash matches (case-insensitive contains)
  if (a.role !== b.role) return false;
  const an = a.accessibleName.toLowerCase();
  const bn = b.accessibleName.toLowerCase();
  const at = a.textHash.toLowerCase();
  const bt = b.textHash.toLowerCase();
  const nameMatch = an && bn && (an.includes(bn) || bn.includes(an));
  const textMatch = at && bt && (at.includes(bt) || bt.includes(at));
  return Boolean(nameMatch || textMatch);
}

// Build fingerprint from evaluated element data
export function buildFingerprint(data: {
  role: string;
  accessibleName: string;
  text: string;
  box: { x: number; y: number; w: number; h: number };
  pathHash: string;
}): Fingerprint {
  return {
    role: data.role || "generic",
    accessibleName: (data.accessibleName || "").trim().slice(0, 80),
    textHash: hashText(data.text || ""),
    box: {
      x: Math.round(data.box.x),
      y: Math.round(data.box.y),
      w: Math.round(data.box.w),
      h: Math.round(data.box.h),
    },
    pathHash: data.pathHash || "",
  };
}
