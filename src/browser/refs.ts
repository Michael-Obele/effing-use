import type { Page, Locator } from "playwright";
import {
  getFingerprint,
  buildFingerprint,
  chooseRebindIndex,
  RAW_FP_SCRIPT,
  type Fingerprint,
  type RawFp,
  type RebindCandidate,
} from "./identity.js";

export class EngineError extends Error {
  code: string;
  hint: string;
  data?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    hint: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.data = data;
  }
}

const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, [role=button], [tabindex]";

/** Resolve `eNN` snapshot refs via nth-match on interactive elements. */
export function resolveRef(page: Page, ref: string): Locator {
  const m = /^e(\d+)$/i.exec(ref.trim());
  if (!m) throw new Error("not an e-ref");
  return page.locator(INTERACTIVE_SELECTOR).nth(Number(m[1]));
}

export async function resolveLocator(
  page: Page,
  target: string,
  sessionId?: string,
): Promise<Locator> {
  const t = target.trim();
  // 0. eNN ref — with identity validation when sessionId is known
  if (/^e\d+$/i.test(t)) {
    const loc = resolveRef(page, t);
    if ((await loc.count()) === 0) {
      throw new EngineError(
        "E_NOT_FOUND",
        `No element matches "${t}".`,
        "Call browser_observe kind=snapshot first to refresh refs, then use a fresh e-ref.",
      );
    }
    if (sessionId) {
      const expected = getFingerprint(sessionId, t);
      if (expected) {
        // Validate against the SAME extractor that registered the snapshot
        const raws = (await page.evaluate(RAW_FP_SCRIPT).catch(() => null)) as
          | RawFp[]
          | null;
        const idx = Number(t.slice(1));
        const actual = raws && raws[idx] ? buildFingerprint(raws[idx]) : null;
        if (actual) {
          const exact =
            expected.role === actual.role &&
            expected.accessibleName === actual.accessibleName &&
            expected.textHash === actual.textHash;
          if (!exact) {
            // Conservative rebind — ambiguous → E_STALE, never guess
            const rebound = await findRebound(page, expected, raws);
            if (rebound) {
              // Return rebound locator; caller can check rebound flag via session
              (page as unknown as Record<string, unknown>).__rebound = true;
              return rebound;
            }
            throw new EngineError(
              "E_STALE",
              `Ref ${t} is stale — element changed.`,
              "Call browser_observe kind=snapshot to refresh refs.",
              { expected, actual },
            );
          }
        }
      }
    }
    return loc;
  }
  // 1. role= selector passes through
  if (t.startsWith("role=")) return page.locator(t);
  // 2. CSS-ish (starts with #, ., [, //, or tag)
  if (/^[#.\[/a-zA-Z]/.test(t) && !t.includes(" ")) {
    try {
      const css = page.locator(`css=${t}`);
      if ((await css.count()) > 0) return css.first();
    } catch {
      /* fall through */
    }
  }
  // try as generic CSS anyway
  try {
    const any = page.locator(t);
    if ((await any.count()) > 0) return any.first();
  } catch {
    /* fall through to fuzzy */
  }
  // 3. fuzzy label on interactive roles
  const fuzzy = page
    .getByRole("button", { name: t })
    .or(page.getByRole("link", { name: t }))
    .or(page.getByRole("textbox", { name: t }))
    .or(page.getByText(t));
  if ((await fuzzy.count()) > 0) return fuzzy.first();
  throw new EngineError(
    "E_NOT_FOUND",
    `No element matches "${t}".`,
    "Call browser_observe kind=snapshot first, then use an e-ref, role= selector, or CSS selector.",
  );
}

/**
 * Find where the element `expected` used to describe lives now.
 * Uses the shared extractor + conservative chooser: only an UNAMBIGUOUS match
 * is returned; zero or several equally-good candidates → null → E_STALE
 * upstream (v0.2 bug: first-match rebind clicked toggle-all).
 */
async function findRebound(
  page: Page,
  expected: Fingerprint,
  raws: RawFp[] | null,
): Promise<Locator | null> {
  const list =
    raws ?? ((await page.evaluate(RAW_FP_SCRIPT).catch(() => [])) as RawFp[]);
  const candidates: RebindCandidate[] = list.map((r, i) => ({
    index: i,
    fp: buildFingerprint(r),
  }));
  const pick = chooseRebindIndex(expected, candidates);
  if (pick === null) return null;
  return page.locator(INTERACTIVE_SELECTOR).nth(pick);
}

/**
 * Resolve a portable, standalone selector for a target (plan §6.2 preference:
 * id → name → ARIA label → stable data-* → placeholder → recorded text).
 * Never returns nth-index or session-scoped e-refs; null when nothing unique
 * can be found (caller falls back to the raw target).
 */
export async function stableSelectorFor(
  page: Page,
  target: string,
  sessionId?: string,
): Promise<string | null> {
  try {
    const loc = await resolveLocator(page, target, sessionId);
    const cands = await loc
      .first()
      .evaluate((el) => {
        const out: string[] = [];
        const tag = el.tagName.toLowerCase();
        const esc = (s: string) => {
          const c = (
            globalThis as unknown as {
              CSS?: { escape?: (x: string) => string };
            }
          ).CSS;
          return c && c.escape ? c.escape(s) : s;
        };
        const av = (s: string): string | null => {
          const bs = String.fromCharCode(92);
          if (s.indexOf('"') !== -1 || s.indexOf(bs) !== -1) return null;
          return '"' + s + '"';
        };
        const uniq = (s: string): boolean => {
          try {
            return document.querySelectorAll(s).length === 1;
          } catch {
            return false;
          }
        };
        // 1. stable id (skip framework-generated/dynamic ids)
        const id = el.getAttribute("id");
        if (
          id &&
          !/^(bits|radix|headlessui|react-aria|ember|react-|:)/.test(id) &&
          !/[-_]\d+$/.test(id) &&
          uniq("#" + esc(id))
        ) {
          out.push("#" + esc(id));
        }
        // 2. name attribute
        const name = el.getAttribute("name");
        if (name) {
          const a = av(name);
          if (a && uniq("[name=" + a + "]")) out.push("[name=" + a + "]");
        }
        // 3. ARIA label on the element itself
        const aria = el.getAttribute("aria-label");
        if (aria) {
          const a = av(aria);
          if (a && uniq(tag + "[aria-label=" + a + "]"))
            out.push(tag + "[aria-label=" + a + "]");
        }
        // 4. stable data-* (test attrs preferred; state/animation attrs skipped)
        const attrs = Array.prototype.slice.call(el.attributes) as Array<{
          name: string;
          value: string;
        }>;
        const dataAttrs = attrs.filter(
          (a) =>
            a.name.startsWith("data-") &&
            !/^data-(state|orientation|index|selected|active|highlighted|value|radix|size|style|theme)/.test(
              a.name,
            ),
        );
        dataAttrs.sort((a, b) => {
          const score = (n: string) =>
            /^data-(test|testid|cy)/.test(n) ? 0 : 1;
          return score(a.name) - score(b.name);
        });
        for (const a of dataAttrs) {
          const v = av(a.value);
          if (!v) continue;
          const s = tag + "[" + a.name + "=" + v + "]";
          if (uniq(s)) {
            out.push(s);
            break;
          }
        }
        // 5. placeholder (form controls with no name/id)
        const ph = el.getAttribute("placeholder");
        if (ph) {
          const a = av(ph);
          if (a && uniq(tag + "[placeholder=" + a + "]"))
            out.push(tag + "[placeholder=" + a + "]");
        }
        // 6. recorded text (Playwright exact text engine)
        const text = (el.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60);
        if (text && (tag === "button" || tag === "a")) {
          const a = av(text);
          if (a) out.push("text=" + a);
        }
        return out;
      })
      .catch(() => [] as string[]);
    for (const c of cands) {
      const n = await page
        .locator(c)
        .count()
        .catch(() => 0);
      if (n === 1) return c;
    }
    return null;
  } catch {
    return null;
  }
}
