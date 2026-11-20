import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { computeDelta as mobileDelta } from "../src/diff.js";

/**
 * The mobile package ships its own copy of the snapshot delta so it can publish
 * without reaching into the browser package. The line format is the contract
 * between them — this test fails the moment the two disagree.
 *
 * The sibling is imported dynamically: the mobile package must typecheck and
 * test on its own, and a static import would drag the browser package (and
 * Playwright) into its dependency graph. That also means the sibling is absent
 * when this package is installed from npm — hence the skip below.
 */
const BROWSER_DELTA = "../../browser/src/browser/delta.ts";
const browserDelta: typeof mobileDelta | null = await (async () => {
  try {
    const mod = await import("../../browser/src/browser/delta.js");
    return mod.computeDelta as typeof mobileDelta;
  } catch {
    return null;
  }
})();

// Quiet skipping is how a guard rots: if the rest of the repo is right here but
// the import failed, the path is wrong, not the environment.
const repoLayoutPresent = existsSync(
  new URL("../../browser/package.json", import.meta.url),
);
if (repoLayoutPresent && !browserDelta) {
  throw new Error(
    `Browser package is present but ${BROWSER_DELTA} could not be imported — the parity guard is blind. Fix the path.`,
  );
}
const HEADER =
  "# Snapshot — refs are per-snapshot.\n# url: http://localhost/\n";

const cases: Array<[string, string, string]> = [
  [
    "no-op",
    `${HEADER}[e0] button "Sign in"\n[e1] input "Email"`,
    `${HEADER}[e0] button "Sign in"\n[e1] input "Email"`,
  ],
  [
    "url change only",
    `${HEADER}[e0] button "Sign in"`,
    '# Snapshot — refs are per-snapshot.\n# url: http://localhost/next\n[e0] button "Sign in"',
  ],
  [
    "ref renumbering from an insert",
    `${HEADER}[e0] button "Sign in"\n[e1] button "Delete"\n[e2] button "Save"`,
    `${HEADER}[e0] button "Sign in"\n[e1] button "New"\n[e2] button "Delete"\n[e3] button "Save"`,
  ],
  [
    "content change",
    `${HEADER}[e0] button "Sign in"`,
    `${HEADER}[e0] button "Signed in"`,
  ],
  ["first observation", "", `${HEADER}[e0] button "Sign in"`],
  [
    "duplicate labels",
    `${HEADER}[e0] a "Pricing"\n[e1] a "Pricing"`,
    `${HEADER}[e0] a "Pricing"\n[e1] a "Pricing"\n[e2] a "Pricing"`,
  ],
];

describe("snapshot delta parity", () => {
  for (const [name, before, after] of cases) {
    test.skipIf(!browserDelta)(name, () => {
      const mobile = mobileDelta(before || null, after);
      const browser = browserDelta!(before || null, after);
      expect(mobile).toEqual(browser);
    });
  }

  test.skipIf(!browserDelta)(
    "the copies really are two implementations",
    () => {
      // Guards against a future refactor accidentally re-exporting one from the
      // other, which would make this whole file vacuous.
      expect(mobileDelta).not.toBe(browserDelta!);
    },
  );
});
