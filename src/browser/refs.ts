import type { Page, Locator } from "playwright";

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
): Promise<Locator> {
  const t = target.trim();
  // 0. eNN ref
  if (/^e\d+$/i.test(t)) {
    const loc = resolveRef(page, t);
    if ((await loc.count()) > 0) return loc;
    throw new EngineError(
      "E_NOT_FOUND",
      `No element matches "${t}".`,
      "Call browser_observe kind=snapshot first to refresh refs, then use a fresh e-ref.",
    );
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
