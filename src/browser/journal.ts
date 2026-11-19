import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";

export type JournalEventType =
  | "call"
  | "console"
  | "pageerror"
  | "response"
  | "requestfailed"
  | "navigation"
  | "crash";

export type JournalInput = {
  type: JournalEventType;
  ts?: string;
  callId?: string;
  url?: string;
  [key: string]: unknown;
};

export type JournalEvent = JournalInput & {
  seq: number;
  id: string;
  ts: string;
  sessionId: string;
};

export type JournalCall = {
  tool: "act" | "observe" | "extract";
  key: string;
  durationMs: number;
  ok: boolean;
  code?: string;
  url?: string;
  path?: string;
};

export type JournalFilter = {
  since?: string; // ISO or relative: 30s, 5m, 2h, 1d
  type?: JournalEventType | JournalEventType[];
  level?: string;
  filter?: string;
  limit?: number;
  offset?: number;
};

export type JournalRead = {
  events: JournalEvent[];
  total: number;
  path: string;
  truncated: boolean;
};

const MAX_FIELD_CHARS = 4000;
const MAX_LINE_CHARS = 300;
const DEFAULT_MAX_BYTES = 2_000_000;

const SECRET_KEY_RE =
  /pass(word)?|secret|token|otp|pin|ssn|authorization|cookie|set-cookie|api[-_]?key/i;

const RELATIVE_SINCE_RE = /^(\d+)\s*(s|m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
}

export function journalDir(config: Config, sessionId: string): string {
  return join(config.outputDir, "sessions", sanitizeSegment(sessionId));
}

export function journalPath(config: Config, sessionId: string): string {
  return join(journalDir(config, sessionId), "journal.jsonl");
}

function rotatedJournalPath(config: Config, sessionId: string): string {
  return join(journalDir(config, sessionId), "journal.1.jsonl");
}

export function parseSince(
  raw: string,
  now: number = Date.now(),
): string | null {
  const trimmed = raw.trim();
  const rel = RELATIVE_SINCE_RE.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1]);
    const mult = UNIT_MS[rel[2].toLowerCase()];
    if (Number.isFinite(amount) && mult) {
      return new Date(now - amount * mult).toISOString();
    }
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return null;
}

function clipString(s: string, max: number = MAX_FIELD_CHARS): string {
  return s.length > max ? s.slice(0, max) : s;
}

function clipDeep<T>(value: T): T {
  if (typeof value === "string") return clipString(value) as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => clipDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = clipDeep(v);
    }
    return out as T;
  }
  return value;
}

function redactDeep<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "«redacted»" : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

// Per-process, per-session sequence counters. Reset on restart — fine, since
// the journal is a debugging aid, not a durable log.
const seqCounters = new Map<string, number>();

function nextSeq(sessionId: string): number {
  const seq = (seqCounters.get(sessionId) ?? 0) + 1;
  seqCounters.set(sessionId, seq);
  return seq;
}

let callCounter = 0;

// Serializes writes per session so concurrent appendEvent calls can't
// interleave lines in the file. Each entry is the tail of that session's
// write chain; it never rejects (errors are swallowed inside the task), so
// a failed write never poisons later writes for the same session.
const writeChains = new Map<string, Promise<void>>();

function enqueueWrite(
  sessionId: string,
  task: () => Promise<void>,
): Promise<void> {
  const prev = writeChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(task, task).catch(() => undefined);
  writeChains.set(sessionId, next);
  return next;
}

async function rotateIfNeeded(
  config: Config,
  sessionId: string,
  lineLength: number,
): Promise<void> {
  const path = journalPath(config, sessionId);
  const maxBytes = config.journalMaxBytes ?? DEFAULT_MAX_BYTES;
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    size = 0;
  }
  if (size + lineLength <= maxBytes) return;
  const rotated = rotatedJournalPath(config, sessionId);
  await rm(rotated, { force: true }).catch(() => undefined);
  await rename(path, rotated).catch(() => undefined);
}

async function writeLine(
  config: Config,
  sessionId: string,
  line: string,
): Promise<void> {
  await mkdir(journalDir(config, sessionId), { recursive: true });
  await rotateIfNeeded(config, sessionId, line.length);
  await appendFile(journalPath(config, sessionId), `${line}\n`, "utf-8");
}

export async function appendEvent(
  config: Config,
  sessionId: string,
  event: JournalInput,
): Promise<JournalEvent | null> {
  if (config.journal === false) return null;
  const seq = nextSeq(sessionId);
  const ts = event.ts ?? new Date().toISOString();
  const id = `${Date.now()}-${seq}`;
  const full: JournalEvent = { ...event, ts, seq, id, sessionId };
  const shaped =
    config.recordRedact !== false ? clipDeep(redactDeep(full)) : clipDeep(full);
  const line = JSON.stringify(shaped);
  await enqueueWrite(sessionId, () =>
    writeLine(config, sessionId, line).catch(() => undefined),
  );
  return shaped;
}

export async function appendCall(
  config: Config,
  sessionId: string,
  call: JournalCall,
): Promise<string> {
  callCounter += 1;
  const callId = `call-${Date.now()}-${callCounter}`;
  await appendEvent(config, sessionId, { type: "call", callId, ...call });
  return callId;
}

async function readEventsFromFile(path: string): Promise<JournalEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const events: JournalEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        events.push(parsed as JournalEvent);
      }
    } catch {
      // skip malformed line
    }
  }
  return events;
}

function matchesFilter(
  event: JournalEvent,
  filter: JournalFilter,
  sinceIso: string | undefined,
  types: JournalEventType[] | undefined,
): boolean {
  if (types && !types.includes(event.type)) return false;
  if (sinceIso !== undefined) {
    const eventTime = Date.parse(event.ts);
    const sinceTime = Date.parse(sinceIso);
    if (
      !Number.isNaN(eventTime) &&
      !Number.isNaN(sinceTime) &&
      eventTime < sinceTime
    ) {
      return false;
    }
  }
  if (filter.level !== undefined) {
    if (event.type !== "console") return false;
    const level = (event as Record<string, unknown>).level;
    if (
      typeof level !== "string" ||
      level.toLowerCase() !== filter.level.toLowerCase()
    ) {
      return false;
    }
  }
  if (filter.filter) {
    const needle = filter.filter.toLowerCase();
    const haystack =
      `${event.type} ${event.url ?? ""} ${JSON.stringify(event)}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export async function readJournal(
  config: Config,
  sessionId: string,
  filter: JournalFilter = {},
): Promise<JournalRead> {
  // Browser listeners append with `void appendEvent(...)`. Drain the chain
  // before reading so a query immediately after a page event sees it.
  await flushJournal(sessionId);
  const path = journalPath(config, sessionId);
  const rotated = rotatedJournalPath(config, sessionId);
  const events = [
    ...(await readEventsFromFile(rotated)),
    ...(await readEventsFromFile(path)),
  ];

  const sinceIso =
    filter.since !== undefined
      ? (parseSince(filter.since) ?? undefined)
      : undefined;
  const types =
    filter.type === undefined
      ? undefined
      : Array.isArray(filter.type)
        ? filter.type
        : [filter.type];

  const filtered = events.filter((e) =>
    matchesFilter(e, filter, sinceIso, types),
  );
  const total = filtered.length;
  const offset = filter.offset ?? 0;
  const sliced =
    filter.limit !== undefined
      ? filtered.slice(offset, offset + filter.limit)
      : filtered.slice(offset);

  return {
    events: sliced,
    total,
    path,
    truncated: offset + sliced.length < total,
  };
}

type ErrorField = Record<string, unknown>;

export function summarizeErrors(events: JournalEvent[]): {
  total: number;
  pageErrors: Array<{
    message: string;
    name?: string;
    count: number;
    firstAt: string;
    lastAt: string;
    stack?: string;
  }>;
  consoleErrors: Array<{
    text: string;
    count: number;
    firstAt: string;
    lastAt: string;
    url?: string;
    line?: number;
  }>;
  networkFailures: Array<{
    method: string;
    url: string;
    status: number;
    count: number;
    firstAt: string;
    lastAt: string;
    failure?: string;
  }>;
} {
  const pageErrors = new Map<
    string,
    {
      message: string;
      name?: string;
      count: number;
      firstAt: string;
      lastAt: string;
      stack?: string;
    }
  >();
  const consoleErrors = new Map<
    string,
    {
      text: string;
      count: number;
      firstAt: string;
      lastAt: string;
      url?: string;
      line?: number;
    }
  >();
  const networkFailures = new Map<
    string,
    {
      method: string;
      url: string;
      status: number;
      count: number;
      firstAt: string;
      lastAt: string;
      failure?: string;
    }
  >();

  let total = 0;

  for (const e of events) {
    const f = e as ErrorField;
    if (e.type === "pageerror") {
      total += 1;
      const message = String(f.message ?? "");
      const name = typeof f.name === "string" ? f.name : undefined;
      const key = `${name ?? ""}::${message}`;
      const existing = pageErrors.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastAt = e.ts;
      } else {
        pageErrors.set(key, {
          message,
          name,
          count: 1,
          firstAt: e.ts,
          lastAt: e.ts,
          stack: typeof f.stack === "string" ? f.stack : undefined,
        });
      }
      continue;
    }

    if (e.type === "console" && f.level === "error") {
      total += 1;
      const text = String(f.text ?? "");
      const url = typeof f.url === "string" ? f.url : undefined;
      const key = `${text}::${url ?? ""}`;
      const existing = consoleErrors.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastAt = e.ts;
      } else {
        consoleErrors.set(key, {
          text,
          count: 1,
          firstAt: e.ts,
          lastAt: e.ts,
          url,
          line: typeof f.line === "number" ? f.line : undefined,
        });
      }
      continue;
    }

    const isRequestFailed = e.type === "requestfailed";
    const status = typeof f.status === "number" ? f.status : undefined;
    const isBadResponse =
      e.type === "response" &&
      ((status !== undefined && status >= 400) || f.ok === false);
    if (isRequestFailed || isBadResponse) {
      total += 1;
      const method = String(f.method ?? "");
      const url = String(e.url ?? "");
      const failure = typeof f.failure === "string" ? f.failure : undefined;
      const key = `${method}::${url}::${status ?? ""}::${failure ?? ""}`;
      const existing = networkFailures.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastAt = e.ts;
      } else {
        networkFailures.set(key, {
          method,
          url,
          status: status ?? 0,
          count: 1,
          firstAt: e.ts,
          lastAt: e.ts,
          failure,
        });
      }
    }
  }

  return {
    total,
    pageErrors: [...pageErrors.values()].slice(0, 20),
    consoleErrors: [...consoleErrors.values()].slice(0, 20),
    networkFailures: [...networkFailures.values()].slice(0, 20),
  };
}

export function formatEventLine(event: JournalEvent): string {
  const f = event as ErrorField;
  let line: string;
  switch (event.type) {
    case "call": {
      const tool = String(f.tool ?? "");
      const key = String(f.key ?? "");
      const status = f.ok ? "ok" : "fail";
      const durationMs = f.durationMs ?? "?";
      const url = typeof f.url === "string" ? ` — ${f.url}` : "";
      line = `[call] ${tool}:${key} ${status} ${durationMs}ms${url}`;
      break;
    }
    case "console": {
      const level = typeof f.level === "string" ? f.level : "log";
      const text = String(f.text ?? "");
      const url = typeof f.url === "string" ? f.url : "";
      const lineNo = typeof f.line === "number" ? `:${f.line}` : "";
      const loc = url ? ` — ${url}${lineNo}` : "";
      line = `[console:${level}] ${text}${loc}`;
      break;
    }
    case "pageerror": {
      line = `[pageerror] ${String(f.message ?? "")}`;
      break;
    }
    case "response": {
      const method = String(f.method ?? "");
      const url = String(event.url ?? "");
      const status = f.status ?? "?";
      const durationMs =
        typeof f.durationMs === "number" ? ` (${f.durationMs}ms)` : "";
      line = `[net] ${method} ${url} → ${status}${durationMs}`;
      break;
    }
    case "requestfailed": {
      const method = String(f.method ?? "");
      const url = String(event.url ?? "");
      const failure = String(f.failure ?? "");
      line = `[netfail] ${method} ${url} — ${failure}`;
      break;
    }
    case "navigation": {
      line = `[nav] ${String(event.url ?? "")}`;
      break;
    }
    case "crash": {
      line = `[crash] page crashed`;
      break;
    }
    default: {
      line = `[${event.type}]`;
    }
  }
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

export async function flushJournal(sessionId?: string): Promise<void> {
  if (sessionId !== undefined) {
    await (writeChains.get(sessionId) ?? Promise.resolve());
    return;
  }
  await Promise.all([...writeChains.values()]);
}

export function clearJournalState(sessionId: string): void {
  seqCounters.delete(sessionId);
  writeChains.delete(sessionId);
}
