export type Fingerprint = {
  role: string;
  accessibleName: string;
  textHash: string;
  box: { x: number; y: number; w: number; h: number };
  pathHash: string;
};

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
