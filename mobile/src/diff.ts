/**
 * Snapshot delta: content-multiset diff over snapshot lines.
 *
 * A deliberate copy of `computeDelta` from the browser package's
 * `src/browser/delta.ts`, minus the Playwright-specific dirty-tracking. Refs are
 * POSITIONS, so one inserted element renumbers every later `[eN]`; a naive line
 * diff then reports the whole list as changed. Diffing on content instead is
 * what keeps a re-observation after a no-op at ~20 tokens.
 *
 * The browser and mobile snapshots use the same line format on purpose, and
 * `tests/parity.test.ts` asserts this copy and the original agree.
 */
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
