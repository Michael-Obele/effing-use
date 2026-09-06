import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { Config } from "../config.js";

let browser: Browser | null = null;

interface SessionEntry {
  context: BrowserContext;
  page: Page;
  consoleLogs: Array<{ type: string; text: string; at: string }>;
  networkLogs: Array<{ method: string; url: string; status: number }>;
}

const sessions = new Map<string, SessionEntry>();

async function getBrowser(config: Config): Promise<Browser> {
  if (browser && !browser.isConnected()) {
    sessions.clear();
    browser = null;
  }
  if (!browser) {
    browser = await chromium.launch({
      headless: config.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browser;
}

export async function getPage(
  config: Config,
  sessionId = "default",
): Promise<Page> {
  const existing = sessions.get(sessionId);
  if (existing && !existing.page.isClosed()) return existing.page;
  if (existing) sessions.delete(sessionId);
  const b = await getBrowser(config);
  const context = await b.newContext({
    viewport: { width: config.viewportW, height: config.viewportH },
  });
  const page = await context.newPage();
  const entry: SessionEntry = {
    context,
    page,
    consoleLogs: [],
    networkLogs: [],
  };
  page.on("console", (msg) => {
    entry.consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      at: new Date().toISOString(),
    });
    if (entry.consoleLogs.length > 50) entry.consoleLogs.shift();
  });
  page.on("response", (res) => {
    entry.networkLogs.push({
      method: res.request().method(),
      url: res.url(),
      status: res.status(),
    });
    if (entry.networkLogs.length > 50) entry.networkLogs.shift();
  });
  sessions.set(sessionId, entry);
  return page;
}

export async function getContext(
  config: Config,
  sessionId = "default",
): Promise<BrowserContext> {
  const existing = sessions.get(sessionId);
  if (existing && !existing.page.isClosed()) return existing.context;
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

export async function closeSession(sessionId = "default"): Promise<void> {
  const s = sessions.get(sessionId);
  if (s) {
    await s.context.close().catch(() => undefined);
    sessions.delete(sessionId);
  }
}

export async function closeAll(): Promise<void> {
  for (const id of [...sessions.keys()]) await closeSession(id);
  if (browser) {
    await browser.close();
    browser = null;
  }
}
