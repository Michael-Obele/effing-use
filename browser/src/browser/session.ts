import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from "playwright";
import type { Config } from "../config.js";
import { appendEvent, clearJournalState, flushJournal } from "./journal.js";

type ConsoleEntry = {
  type: string;
  text: string;
  at: string;
  url?: string;
  line?: number;
  column?: number;
};

type NetworkEntry = {
  method: string;
  url: string;
  status: number;
  at: string;
  requestId?: string;
  resourceType?: string;
  ok?: boolean;
  durationMs?: number;
};

// Playwright 1.63 has no public request id. A per-process WeakMap gives the
// response and requestfailed listeners the same stable id for one Request
// object, so the journal can correlate them without fabricating a protocol id.
const requestIds = new WeakMap<Request, string>();
let requestCounter = 0;

function requestIdFor(req: Request): string {
  let id = requestIds.get(req);
  if (!id) {
    requestCounter += 1;
    id = `req-${requestCounter}`;
    requestIds.set(req, id);
  }
  return id;
}

let browser: Browser | null = null;
let browserLastUsed = Date.now();
let browserStartedAt: number | null = null;
let reaperStarted = false;

interface SessionEntry {
  context: BrowserContext;
  page: Page;
  consoleLogs: ConsoleEntry[];
  networkLogs: NetworkEntry[];
  mustObserve: boolean;
  lastUsed: number;
  createdAt: number;
  calls: number;
}

const sessions = new Map<string, SessionEntry>();

// --- lightweight telemetry (no deps, no sampling overhead) ---
type CallStat = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: string;
};
const callStats = new Map<string, CallStat>();
let slowCalls: Array<{
  at: string;
  tool: string;
  key: string;
  ms: number;
  sessionId: string;
  url?: string;
}> = [];

export function recordCall(
  tool: string,
  key: string,
  ms: number,
  sessionId = "default",
  url?: string,
): void {
  const k = `${tool}:${key}`;
  let s = callStats.get(k);
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, lastAt: "" };
    callStats.set(k, s);
  }
  s.count += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = Math.round(ms);
  s.lastAt = new Date().toISOString();
  if (ms > 1500) {
    slowCalls.push({
      at: new Date().toISOString(),
      tool,
      key,
      ms: Math.round(ms),
      sessionId,
      url,
    });
    if (slowCalls.length > 50) slowCalls = slowCalls.slice(-50);
  }
}

export function getTelemetry(): Record<string, unknown> {
  const calls: Record<string, unknown> = {};
  for (const [k, s] of callStats) {
    calls[k] = {
      count: s.count,
      avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
      maxMs: s.maxMs,
      lastAt: s.lastAt,
    };
  }
  const now = Date.now();
  const sess: Record<string, unknown> = {};
  for (const [id, e] of sessions) {
    sess[id] = {
      url: safeUrl(e.page),
      idleSec: Math.round((now - e.lastUsed) / 1000),
      ageSec: Math.round((now - e.createdAt) / 1000),
      calls: e.calls,
      tabs: safeTabCount(e.context),
    };
  }
  return {
    uptimeSec: browserStartedAt
      ? Math.round((now - browserStartedAt) / 1000)
      : 0,
    browserIdleSec: Math.round((now - browserLastUsed) / 1000),
    sessions: sess,
    calls,
    slowCalls: slowCalls.slice(-20),
  };
}

function safeUrl(page: Page): string {
  try {
    return page.isClosed() ? "(closed)" : page.url();
  } catch {
    return "(unknown)";
  }
}

function safeTabCount(ctx: BrowserContext): number {
  try {
    return ctx.pages().length;
  } catch {
    return -1;
  }
}

export function touchSession(sessionId = "default"): void {
  const s = sessions.get(sessionId);
  const now = Date.now();
  if (s) {
    s.lastUsed = now;
    s.calls += 1;
  }
  browserLastUsed = now;
}

function ensureReaper(config: Config): void {
  if (reaperStarted) return;
  reaperStarted = true;
  const timer = setInterval(() => {
    void reapIdle(config).catch(() => undefined);
  }, 60_000);
  // Don't hold the process open for the reaper alone.
  (timer as unknown as { unref?: () => void }).unref?.();
}

async function reapIdle(config: Config): Promise<void> {
  const now = Date.now();
  const idleTtl = config.idleTtlMs ?? 300000;
  const browserTtl = config.browserTtlMs ?? 600000;
  if (idleTtl > 0) {
    for (const [id, e] of [...sessions]) {
      if (now - e.lastUsed > idleTtl) {
        await e.context.close().catch(() => undefined);
        await flushJournal(id).catch(() => undefined);
        clearJournalState(id);
        sessions.delete(id);
        if (process.env.EFFING_DEBUG) {
          console.error(
            `[effing-use] reaped idle session "${id}" after ${Math.round((now - e.lastUsed) / 1000)}s`,
          );
        }
      }
    }
  }
  if (browser && sessions.size === 0 && browserTtl > 0) {
    if (now - browserLastUsed > browserTtl) {
      await browser.close().catch(() => undefined);
      browser = null;
      browserStartedAt = null;
      if (process.env.EFFING_DEBUG) {
        console.error("[effing-use] closed idle browser");
      }
    }
  }
}

async function getBrowser(config: Config): Promise<Browser> {
  ensureReaper(config);
  if (browser && !browser.isConnected()) {
    sessions.clear();
    browser = null;
    browserStartedAt = null;
  }
  if (!browser) {
    browser = await chromium.launch({
      headless: config.headless,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Idle + render cost. Software GL (SwiftShader) burns host CPU for
        // every canvas/WebGL/composite; headless screenshots don't need it.
        "--disable-gpu",
        // Never autoplay video/audio without a user gesture — a background
        // tab left on a media page otherwise decodes forever.
        "--autoplay-policy=user-gesture-required",
        // Tell pages to skip animations; paired with reducedMotion below.
        "--force-prefers-reduced-motion",
      ],
      // Playwright disables background throttling by default so background
      // tabs run at full speed. For an agent browser that sits idle between
      // calls, that means a left-open SPA (Vite HMR, dashboards, ads) spins
      // rAF/timers forever. Re-enable throttling.
      ignoreDefaultArgs: [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    });
    browserLastUsed = Date.now();
    browserStartedAt = Date.now();
  }
  return browser;
}

async function applyAssetBlocking(
  context: BrowserContext,
  config: Config,
): Promise<void> {
  const blocked = new Set(
    (config.blockAssets ?? []).map((s) => s.toLowerCase()),
  );
  if (blocked.size === 0) return;
  await context
    .route("**/*", (route) => {
      const type = route.request().resourceType();
      if (blocked.has(type)) return route.abort().catch(() => undefined);
      return route.continue().catch(() => undefined);
    })
    .catch(() => undefined);
}

function safeLocation(msg: ConsoleMessage): {
  url?: string;
  line?: number;
  column?: number;
} {
  try {
    const loc = msg.location();
    return {
      ...(loc.url ? { url: loc.url } : {}),
      ...(typeof loc.lineNumber === "number" ? { line: loc.lineNumber } : {}),
      ...(typeof loc.columnNumber === "number"
        ? { column: loc.columnNumber }
        : {}),
    };
  } catch {
    return {};
  }
}

function computeDurationMs(res: Response): number | undefined {
  try {
    const t = res.request().timing();
    const start = t?.startTime ?? -1;
    const end = t?.responseEnd ?? -1;
    return start >= 0 && end >= 0 ? Math.round(end - start) : undefined;
  } catch {
    return undefined;
  }
}

export async function getPage(
  config: Config,
  sessionId = "default",
): Promise<Page> {
  ensureReaper(config);
  const existing = sessions.get(sessionId);
  if (existing && !existing.page.isClosed()) {
    touchSession(sessionId);
    return existing.page;
  }
  if (existing) sessions.delete(sessionId);
  const b = await getBrowser(config);
  const context = await b.newContext({
    viewport: { width: config.viewportW, height: config.viewportH },
    // Kills CSS animations/transitions + rAF-driven motion on cooperating
    // sites. Zero behavior cost for form/doc scraping, big CPU win on
    // animated dashboards and ad-heavy pages.
    reducedMotion: config.reducedMotion ? "reduce" : undefined,
  });
  await applyAssetBlocking(context, config);
  const page = await context.newPage();
  const now = Date.now();
  const entry: SessionEntry = {
    context,
    page,
    consoleLogs: [],
    networkLogs: [],
    mustObserve: false,
    lastUsed: now,
    createdAt: now,
    calls: 0,
  };
  page.on("console", (msg) => {
    const at = new Date().toISOString();
    const loc = safeLocation(msg);
    entry.consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      at,
      ...loc,
    });
    if (entry.consoleLogs.length > 50) entry.consoleLogs.shift();
    void appendEvent(config, sessionId, {
      type: "console",
      level: msg.type(),
      text: msg.text(),
      at,
      ...loc,
    }).catch(() => undefined);
  });
  page.on("pageerror", (error) => {
    void appendEvent(config, sessionId, {
      type: "pageerror",
      message: error.message,
      name: error.name,
      stack: error.stack,
    }).catch(() => undefined);
  });
  page.on("requestfailed", (req) => {
    void appendEvent(config, sessionId, {
      type: "requestfailed",
      requestId: requestIdFor(req),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText,
    }).catch(() => undefined);
  });
  page.on("response", (res) => {
    const at = new Date().toISOString();
    const req = res.request();
    const method = req.method();
    const status = res.status();
    const resourceType = req.resourceType();
    const ok = res.ok();
    const durationMs = computeDurationMs(res);
    const requestId = requestIdFor(req);
    entry.networkLogs.push({
      method,
      url: res.url(),
      status,
      at,
      requestId,
      resourceType,
      ok,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    if (entry.networkLogs.length > 50) entry.networkLogs.shift();
    void appendEvent(config, sessionId, {
      type: "response",
      requestId,
      method,
      url: res.url(),
      status,
      ok,
      resourceType,
      ...(durationMs !== undefined ? { durationMs } : {}),
    }).catch(() => undefined);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      void appendEvent(config, sessionId, {
        type: "navigation",
        url: page.url(),
        frameUrl: frame.url(),
      }).catch(() => undefined);
    }
  });
  page.on("crash", () => {
    void appendEvent(config, sessionId, {
      type: "crash",
      url: page.url(),
    }).catch(() => undefined);
  });
  sessions.set(sessionId, entry);
  touchSession(sessionId);
  return page;
}

export async function getContext(
  config: Config,
  sessionId = "default",
): Promise<BrowserContext> {
  const existing = sessions.get(sessionId);
  if (existing && !existing.page.isClosed()) {
    touchSession(sessionId);
    return existing.context;
  }
  await getPage(config, sessionId);
  return sessions.get(sessionId)!.context;
}

export function getConsoleLogs(
  sessionId = "default",
): SessionEntry["consoleLogs"] {
  return sessions.get(sessionId)?.consoleLogs ?? [];
}

export function getNetworkLogs(
  sessionId = "default",
): SessionEntry["networkLogs"] {
  return sessions.get(sessionId)?.networkLogs ?? [];
}

export function getMustObserve(sessionId = "default"): boolean {
  return sessions.get(sessionId)?.mustObserve ?? false;
}

export function setMustObserve(sessionId = "default", v: boolean): void {
  const s = sessions.get(sessionId);
  if (s) s.mustObserve = v;
}

export function clearMustObserve(sessionId = "default"): void {
  const s = sessions.get(sessionId);
  if (s) s.mustObserve = false;
}

export async function closeSession(sessionId = "default"): Promise<void> {
  const s = sessions.get(sessionId);
  if (s) {
    // Close first: unload handlers can still emit console/network events.
    // Draining after close catches them; clearing before close would let the
    // late writes repopulate the maps we just removed.
    await s.context.close().catch(() => undefined);
    await flushJournal(sessionId).catch(() => undefined);
    clearJournalState(sessionId);
    sessions.delete(sessionId);
  }
  browserLastUsed = Date.now();
}

export async function closeAll(): Promise<void> {
  for (const id of [...sessions.keys()]) await closeSession(id);
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
    browserStartedAt = null;
  }
}
