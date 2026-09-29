import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Fingerprint } from "./identity.js";

export type RecordStep = {
  seq: number;
  op: string;
  target?: string;
  value?: string;
  targetFingerprint?: Fingerprint;
  resolvedSelector?: string;
  expect?: string;
  valueRedacted?: boolean;
};

type Recording = {
  name: string;
  createdAt: string;
  steps: RecordStep[];
};

const activeRecordings = new Map<
  string,
  { name: string; steps: RecordStep[] }
>();

const SECRET_HINT = /password|otp|secret|token|pin|ssn/i;

function isSecretField(
  fp?: Fingerprint,
  target?: string,
  value?: string,
): boolean {
  const hay = [fp?.accessibleName ?? "", fp?.role ?? "", target ?? ""].join(
    " ",
  );
  if (SECRET_HINT.test(hay)) return true;
  // also check input type=password via target string
  if (/type\s*=\s*password/i.test(target ?? "")) return true;
  return false;
}

export function isRecording(sessionId: string): boolean {
  return activeRecordings.has(sessionId);
}

export function startRecording(sessionId: string, name: string): void {
  activeRecordings.set(sessionId, { name, steps: [] });
}

export function stopRecording(
  sessionId: string,
): { name: string; steps: RecordStep[] } | null {
  const r = activeRecordings.get(sessionId);
  if (!r) return null;
  activeRecordings.delete(sessionId);
  return r;
}

export function captureStep(
  sessionId: string,
  step: Omit<RecordStep, "seq">,
  config: Config,
): void {
  const rec = activeRecordings.get(sessionId);
  if (!rec) return;
  const seq = rec.steps.length;
  let value = step.value;
  let valueRedacted = false;
  if (
    config.recordRedact &&
    value &&
    isSecretField(step.targetFingerprint, step.target, value)
  ) {
    value = "«redacted»";
    valueRedacted = true;
  }
  rec.steps.push({
    seq,
    ...step,
    value,
    ...(valueRedacted ? { valueRedacted: true } : {}),
  });
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "recording";
}

export async function saveRecording(
  config: Config,
  name: string,
  steps: RecordStep[],
): Promise<string> {
  const safe = sanitizeName(name);
  const dir = join(config.outputDir, "recordings");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${safe}.json`);
  const rec: Recording = { name: safe, createdAt: new Date().toISOString(), steps };
  await writeFile(path, JSON.stringify(rec, null, 2), "utf-8");
  return path;
}

export async function loadRecording(
  config: Config,
  name: string,
): Promise<Recording> {
  const safe = sanitizeName(name);
  const path = join(config.outputDir, "recordings", `${safe}.json`);
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as Recording;
}

export function getActiveName(sessionId: string): string | null {
  return activeRecordings.get(sessionId)?.name ?? null;
}
