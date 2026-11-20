import {
  appPids,
  forwardSocket,
  pickDevice,
  removeForward,
  webviewSockets,
  type Device,
} from "./adb.js";
import type { MobileConfig } from "./config.js";
import { Cdp } from "./cdp.js";
import { readCapacitorConfig, type CapacitorInfo } from "./capacitor.js";
import { MobileError } from "./errors.js";
import { formatConsoleArgs, injectRuntime } from "./page.js";
import { lookup } from "node:dns/promises";
import { appendEvent, journalPath, type JournalConfig } from "./journal.js";

export type NetEntry = {
  method: string;
  url: string;
  status?: number;
  ms?: number;
  type?: string;
  error?: string;
};

export type MobileSession = {
  id: string;
  device: Device;
  pkg: string;
  capacitor: CapacitorInfo | null;
  webview: { pid: number; socket: string; port: number; url: string } | null;
  cdp: Cdp | null;
  baseline: string | null;
  console: string[];
  network: NetEntry[];
  inflight: Map<
    string,
    { method: string; url: string; at: number; type: string }
  >;
  calls: number;
  lastCallId: string;
  attachedAt: number;
};

const sessions = new Map<string, MobileSession>();

export function asJournalConfig(cfg: MobileConfig): JournalConfig {
  return {
    outputDir: cfg.outputDir,
    journal: cfg.journal,
    journalMaxBytes: cfg.journalMaxBytes,
    recordRedact: cfg.recordRedact,
  };
}

export function journalFile(cfg: MobileConfig, sid: string): string {
  return journalPath(asJournalConfig(cfg), sid);
}

function trim<T>(array: T[], max: number): void {
  if (array.length > max) array.splice(0, array.length - max);
}

/**
 * Resolve device + package once per session. Package resolution order:
 * explicit env, then the Capacitor config in the working directory — the tool is
 * meant to be started from the app project, so that is the zero-config answer.
 */
export async function getSession(
  cfg: MobileConfig,
  sid: string,
): Promise<MobileSession> {
  const existing = sessions.get(sid);
  if (existing) return existing;
  const device = await pickDevice(cfg);
  const discovered = readCapacitorConfig();
  const pkg = cfg.package ?? discovered?.appId;
  if (!pkg) {
    throw new MobileError(
      "E_NO_APP",
      "No app package to drive.",
      "Run the server from the Capacitor project root (capacitor.config.ts), or set MOBILE_PACKAGE=<applicationId>.",
    );
  }
  const session: MobileSession = {
    id: sid,
    device,
    pkg,
    capacitor: discovered?.appId === pkg ? discovered : null,
    webview: null,
    cdp: null,
    baseline: null,
    console: [],
    network: [],
    inflight: new Map(),
    calls: 0,
    lastCallId: "",
    attachedAt: 0,
  };
  sessions.set(sid, session);
  return session;
}

export function findSession(sid: string): MobileSession | undefined {
  return sessions.get(sid);
}

type DevtoolsTarget = {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

async function devtoolsTargets(
  host: string,
  port: number,
): Promise<{ targets: DevtoolsTarget[]; unreachable?: string }> {
  const res = await fetch(`http://${host}:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  }).catch((e) => (e instanceof Error ? e : new Error(String(e))));
  if (res instanceof Error) {
    return { targets: [], unreachable: res.message };
  }
  if (!res.ok) return { targets: [], unreachable: `HTTP ${res.status}` };
  const targets = (await res.json().catch(() => [])) as DevtoolsTarget[];
  return { targets };
}

/**
 * Chrome's devtools HTTP server rejects any Host header that is not an IP or
 * `localhost` (DNS-rebinding guard). A container therefore cannot use
 * `host.docker.internal` — it must dial the resolved IP, and the WebSocket
 * upgrade goes through the same check, so both URLs use the IP.
 */
async function resolveIpv4(host: string): Promise<string> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch (e) {
    throw new MobileError(
      "E_CDP",
      `Cannot resolve MOBILE_CDP_HOST=${host}: ${e instanceof Error ? e.message : String(e)}`,
      "In a container this should be host.docker.internal (add --add-host=host.docker.internal:host-gateway on Linux).",
    );
  }
}

/**
 * A Capacitor app can outlive its WebView, and an emulator can have several
 * debuggable WebViews at once. Match the socket to the app's own process first;
 * fall back to the only socket when there is exactly one.
 */
async function findSocket(
  serial: string,
  pkg: string,
): Promise<{ pid: number; socket: string }> {
  const pids = await appPids(serial, pkg);
  if (!pids.length) {
    // A force-stopped app leaves its devtools socket in /proc/net/unix for a
    // while. Attaching to it succeeds and then fails on the first command, so
    // check the process, not just the socket.
    throw new MobileError(
      "E_NO_APP",
      `${pkg} is not running.`,
      "Call act action=launch, then retry.",
    );
  }
  const sockets = await webviewSockets(serial);
  const owned = sockets.filter((s) => pids.includes(s.pid));
  if (owned.length) return owned[0];
  if (sockets.length === 1) return sockets[0];
  throw new MobileError(
    "E_NO_WEBVIEW",
    sockets.length === 0
      ? `${pkg} has no debuggable WebView.`
      : `No WebView socket belongs to ${pkg} (pids: ${pids.join(", ")}).`,
    "Use a debug build: Capacitor only enables webContentsDebuggingEnabled in development builds. Then relaunch the app.",
  );
}

export async function attach(
  cfg: MobileConfig,
  session: MobileSession,
): Promise<MobileSession> {
  if (session.cdp && !session.cdp.isClosed) return session;
  const { pid, socket } = await findSocket(session.device.serial, session.pkg);
  const port = await forwardSocket(session.device.serial, socket);
  const host = await resolveIpv4(cfg.cdpHost);
  const { targets, unreachable } = await devtoolsTargets(host, port);
  if (unreachable) {
    await removeForward(session.device.serial, port);
    throw new MobileError(
      "E_CDP",
      `The devtools endpoint at ${host}:${port} is unreachable: ${unreachable}`,
      "adb forwards listen on the machine running the adb server, so in a container set MOBILE_CDP_HOST=host.docker.internal — and start the host server with `adb -a` so forwards bind all interfaces.",
    );
  }
  const pages = targets.filter(
    (t) => t.type === "page" && t.webSocketDebuggerUrl,
  );
  const target =
    pages.find((t) => /^(https?|capacitor|ionic):/.test(t.url)) ?? pages[0];
  if (!target?.webSocketDebuggerUrl) {
    await removeForward(session.device.serial, port);
    throw new MobileError(
      "E_NO_WEBVIEW",
      "The WebView devtools socket answered, but it listed no page target.",
      "Reload the app (act action=reload) and retry; a WebView mid-load can list an empty target set.",
    );
  }
  // adb reports the device-side port in this URL; the host reaches it through
  // the forward we just created, so rewrite host:port to the adb server's host
  // and the forwarded port.
  const path = new URL(target.webSocketDebuggerUrl).pathname;
  const wsUrl = `ws://${host}:${port}${path}`;
  const cdp = await Cdp.connect(wsUrl, cfg.timeoutMs);
  session.cdp = cdp;
  session.webview = { pid, socket, port, url: target.url };
  session.attachedAt = Date.now();
  wire(cfg, session, cdp);
  // The event domains are silent until enabled: without these, console and
  // network rings stay empty and the tool looks like the app is doing nothing.
  await cdp.send("Network.enable").catch(() => undefined);
  await cdp.send("Log.enable").catch(() => undefined);
  await injectRuntime(cdp);
  return session;
}

export async function detach(
  cfg: MobileConfig,
  session: MobileSession,
): Promise<void> {
  session.cdp?.close();
  session.cdp = null;
  session.baseline = null;
  if (session.webview) {
    await removeForward(session.device.serial, session.webview.port);
    session.webview = null;
  }
  void cfg;
}

function wire(cfg: MobileConfig, s: MobileSession, cdp: Cdp): void {
  const jcfg = asJournalConfig(cfg);
  const log = (event: Parameters<typeof appendEvent>[2]) => {
    void appendEvent(jcfg, s.id, event).catch(() => undefined);
  };

  cdp.on("Runtime.consoleAPICalled", (p) => {
    const level = String(p.type ?? "log");
    const text = formatConsoleArgs(
      (p.args as Array<{
        value?: unknown;
        description?: string;
        type?: string;
      }>) ?? [],
    );
    if (!text) return;
    s.console.push(`${level}: ${text}`);
    trim(s.console, 300);
    log({ type: "console", level, text });
  });

  cdp.on("Runtime.exceptionThrown", (p) => {
    const d = (p.exceptionDetails ?? {}) as Record<string, unknown>;
    const ex = (d.exception ?? {}) as Record<string, unknown>;
    const message = String(ex.description ?? d.text ?? "Uncaught exception");
    s.console.push(`pageerror: ${message.slice(0, 400)}`);
    trim(s.console, 300);
    log({
      type: "pageerror",
      message: message.slice(0, 2000),
      name: typeof ex.className === "string" ? ex.className : undefined,
      stack:
        typeof ex.description === "string"
          ? ex.description.slice(0, 4000)
          : undefined,
    });
  });

  cdp.on("Log.entryAdded", (p) => {
    const entry = (p.entry ?? {}) as Record<string, unknown>;
    const level = String(entry.level ?? "info");
    if (level !== "error" && level !== "warning") return;
    const text = String(entry.text ?? "");
    s.console.push(`${level}: ${text}`);
    trim(s.console, 300);
    log({ type: "console", level, text });
  });

  cdp.on("Network.requestWillBeSent", (p) => {
    const req = (p.request ?? {}) as Record<string, unknown>;
    s.inflight.set(String(p.requestId), {
      method: String(req.method ?? "GET"),
      url: String(req.url ?? ""),
      at: Number(p.timestamp ?? 0) * 1000,
      type: String(p.type ?? ""),
    });
  });

  cdp.on("Network.responseReceived", (p) => {
    const id = String(p.requestId);
    const req = s.inflight.get(id);
    const res = (p.response ?? {}) as Record<string, unknown>;
    const entry: NetEntry = {
      method: req?.method ?? "GET",
      url: String(res.url ?? req?.url ?? ""),
      status: Number(res.status ?? 0),
      ms: req ? Math.max(0, Math.round(Date.now() - req.at)) : undefined,
      type: req?.type,
    };
    s.inflight.delete(id);
    s.network.push(entry);
    trim(s.network, 300);
    log({
      type: "response",
      method: entry.method,
      url: entry.url,
      status: entry.status,
      durationMs: entry.ms,
    });
  });

  cdp.on("Network.loadingFailed", (p) => {
    const id = String(p.requestId);
    const req = s.inflight.get(id);
    s.inflight.delete(id);
    const entry: NetEntry = {
      method: req?.method ?? "GET",
      url: req?.url ?? "",
      error: String(p.errorText ?? "failed"),
      type: req?.type,
    };
    s.network.push(entry);
    trim(s.network, 300);
    log({
      type: "requestfailed",
      method: entry.method,
      url: entry.url,
      failure: entry.error,
    });
  });

  cdp.on("Page.frameNavigated", (p) => {
    const frame = (p.frame ?? {}) as Record<string, unknown>;
    if (frame.parentId) return;
    // A navigation invalidates every ref from the previous document.
    s.baseline = null;
    log({ type: "navigation", url: String(frame.url ?? "") });
  });
}

export function nextCallId(s: MobileSession): string {
  s.calls += 1;
  s.lastCallId = `c-${String(s.calls).padStart(4, "0")}`;
  return s.lastCallId;
}

/** A tool that needs the page must fail with the fix, not with a null deref. */
export function requireCdp(s: MobileSession): Cdp {
  if (!s.cdp || s.cdp.isClosed) {
    throw new MobileError(
      "E_NO_WEBVIEW",
      "Not attached to the app's WebView.",
      "Call act action=attach (any observe kind=state also attaches).",
    );
  }
  return s.cdp;
}
