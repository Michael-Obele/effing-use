import type { Page, Locator } from "playwright";
import {
  getFingerprint,
  looseMatch,
  fuzzyMatch,
  type Fingerprint,
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
        const actual = await fingerprintAt(page, loc).catch(() => null);
        if (actual) {
          const exact =
            expected.role === actual.role &&
            expected.accessibleName === actual.accessibleName &&
            expected.textHash === actual.textHash;
          if (!exact) {
            // Try rebind: search tree for loose/fuzzy match
            const rebound = await findRebound(page, expected);
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

async function fingerprintAt(page: Page, loc: Locator): Promise<Fingerprint> {
  const box = await loc.boundingBox().catch(() => null);
  const data = await loc
    .evaluate((el) => {
      const text = (el.textContent ?? "").trim().slice(0, 80);
      const aria = el.getAttribute("aria-label") ?? "";
      const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
      // simple path hash: tag chain
      let cur: Element | null = el;
      const parts: string[] = [];
      while (cur && parts.length < 6) {
        parts.push(cur.tagName.toLowerCase());
        cur = cur.parentElement;
      }
      return { role, accessibleName: aria, text, pathHash: parts.join(">") };
    })
    .catch(() => ({
      role: "generic",
      accessibleName: "",
      text: "",
      pathHash: "",
    }));
  return {
    role: data.role || "generic",
    accessibleName: (data.accessibleName || "").trim().slice(0, 80),
    textHash: (data.text || "").trim().replace(/\s+/g, " ").slice(0, 80),
    box: {
      x: Math.round(box?.x ?? 0),
      y: Math.round(box?.y ?? 0),
      w: Math.round(box?.width ?? 0),
      h: Math.round(box?.height ?? 0),
    },
    pathHash: data.pathHash || "",
  };
}

async function findRebound(
  page: Page,
  expected: Fingerprint,
): Promise<Locator | null> {
  // Scan interactive elements for loose/fuzzy match
  const els = await page
    .evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          "button, a, input, select, textarea, [role=button], [tabindex]",
        ),
      ];
      return nodes.slice(0, 200).map((el, i) => {
        const text = (el.textContent ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        const aria = el.getAttribute("aria-label") ?? "";
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        let cur: Element | null = el;
        const parts: string[] = [];
        while (cur && parts.length < 6) {
          parts.push(cur.tagName.toLowerCase());
          cur = cur.parentElement;
        }
        return {
          i,
          role,
          accessibleName: aria,
          textHash: text,
          pathHash: parts.join(">"),
        };
      });
    })
    .catch(
      () =>
        [] as Array<{
          i: number;
          role: string;
          accessibleName: string;
          textHash: string;
          pathHash: string;
        }>,
    );
  for (const e of els) {
    const cand: Fingerprint = {
      role: e.role,
      accessibleName: e.accessibleName,
      textHash: e.textHash,
      box: { x: 0, y: 0, w: 0, h: 0 },
      pathHash: e.pathHash,
    };
    if (looseMatch(expected, cand)) {
      return page
        .locator(
          "button, a, input, select, textarea, [role=button], [tabindex]",
        )
        .nth(e.i);
    }
  }
  for (const e of els) {
    const cand: Fingerprint = {
      role: e.role,
      accessibleName: e.accessibleName,
      textHash: e.textHash,
      box: { x: 0, y: 0, w: 0, h: 0 },
      pathHash: e.pathHash,
    };
    if (fuzzyMatch(expected, cand)) {
      return page
        .locator(
          "button, a, input, select, textarea, [role=button], [tabindex]",
        )
        .nth(e.i);
    }
  }
  return null;
}
