/**
 * Loopback bridge — make `http://localhost:<port>` work from inside a
 * container without touching the app's dev-server config.
 *
 * WHY THIS EXISTS
 * ---------------
 * A dev server started with the default `vite dev` / `next dev` binds to
 * 127.0.0.1 only. When effing-use runs in Docker (Docker Desktop), the
 * container lives in a LinuxKit VM with its own network namespace, so:
 *
 *   - `localhost:5175` in the container  -> container's own loopback  -> ERR_CONNECTION_REFUSED
 *   - `host.docker.internal:5175`       -> reaches the host, but the Host
 *     header is not `localhost` so Vite >= 6 `server.allowedHosts` returns
 *     `403 Blocked request. This host ("host.docker.internal") is not allowed.`
 *   - `--network host`                    -> maps to the *VM*, not the host
 *
 * There is no IP the container can dial, and we must not edit the app's
 * vite.config.ts to add `server.host` (the whole point of the harness is
 * zero-config local dev).
 *
 * THE FIX
 * -------
 * Run a tiny TCP forwarder *on the host loopback* — no, we do not control the
 * host. Instead we run the forwarder *inside the container* and rewrite the
 * `Host:` header back to `localhost` so the dev server's host allow-list is
 * satisfied, while the TCP connection is made to the real host address.
 *
 * Concretely: a Bun TCP server on 127.0.0.1:<same port> inside the container
 * that splices to the host gateway IP on the same port, rewriting
 * `Host: 127.0.0.1:5175` -> `Host: localhost:5175` in the request head.
 * Chromium then talks plain `http://localhost:5175/` — zero app config.
 *
 * Only engaged when: a loopback URL is requested AND the direct dial fails
 * (i.e. we are containerised). A native `bun src/http.ts` run short-circuits
 * on the successful direct dial and pays ~0 cost.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

/** Config surface (all optional, all auto-detected). */
export interface BridgeOptions {
  /** Disable the bridge entirely (default false). */
  disabled?: boolean;
  /** Extra candidate hosts to try, highest priority first. */
  hosts?: string[];
  /** Dial timeout per candidate, ms. */
  probeTimeoutMs?: number;
  /** Explicit override; skips auto-detection. */
  host?: string;
}

const DEFAULT_HOSTS = ["host.docker.internal", "gateway.docker.internal"];

const bridge = new Map<number, Server>();
/** port -> host that worked. Memoised so we probe once per port. */
const resolved = new Map<number, string>();
let lastGoodHost: string | null = null;

/** True when this process is containerised (best-effort, no deps). */
export function inContainer(): boolean {
  if (process.env.EFFING_IN_CONTAINER === "1") return true;
  if (process.env.EFFING_IN_CONTAINER === "0") return false;
  if (process.platform === "win32") return true; // Docker Desktop default
  try {
    // /.dockerenv on Docker, /run/.containerenv on Podman
    if (Bun.file("/.dockerenv").size >= 0 && existsSyncSafe("/.dockerenv"))
      return true;
    if (existsSyncSafe("/run/.containerenv")) return true;
    const cgroup = readSafe("/proc/1/cgroup") ?? readSafe("/proc/self/cgroup");
    if (cgroup && /docker|containerd|kubepods|podman|lxc/.test(cgroup))
      return true;
  } catch {
    /* best effort */
  }
  return false;
}
function existsSyncSafe(p: string): boolean {
  try {
    return require("node:fs").existsSync(p);
  } catch {
    return false;
  }
}
function readSafe(p: string): string | null {
  try {
    return require("node:fs").readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** Raw TCP probe — resolves true if something accepts on host:port. */
function dialable(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ms);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * First, try the loopback URL as-is. If it works we are NOT containerised
 * (or the container really is the server) — return null and let the caller
 * navigate directly with zero overhead.
 */
async function directWorks(port: number, ms: number): Promise<boolean> {
  return (
    (await dialable("127.0.0.1", port, ms)) || (await dialable("::1", port, ms))
  );
}

/** Find a host address that answers on `port` (container -> host gateway). */
async function findHost(
  port: number,
  opts: BridgeOptions,
): Promise<string | null> {
  const ms = opts.probeTimeoutMs ?? 700;
  const candidates = [
    ...(opts.host ? [opts.host] : []),
    ...(lastGoodHost ? [lastGoodHost] : []),
    ...(opts.hosts ?? DEFAULT_HOSTS),
  ];
  for (const host of candidates) {
    if (await dialable(host, port, ms)) return host;
  }
  return null;
}

const isLoopbackHost = (h: string) =>
  h === "localhost" ||
  h === "127.0.0.1" ||
  h === "::1" ||
  h === "[::1]" ||
  h === "0.0.0.0";

/**
 * Ensure `port` on the container's loopback forwards to the host's `port`.
 * Returns a short status string for evidence/hints, or null when nothing to do.
 */
export async function ensureLoopbackBridge(
  port: number,
  opts: BridgeOptions = {},
): Promise<{
  bridged: boolean;
  via?: string;
  reason?: string;
}> {
  if (opts.disabled) return { bridged: false, reason: "disabled" };
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    return { bridged: false, reason: "invalid-port" };
  if (bridge.has(port)) {
    return { bridged: true, via: resolved.get(port) ?? lastGoodHost ?? "?" };
  }

  // 1) Already reachable directly → nothing to do (native run).
  if (await directWorks(port, opts.probeTimeoutMs ?? 400)) {
    resolved.set(port, "loopback");
    return { bridged: false, reason: "already-reachable" };
  }

  // 2) Find the host gateway.
  const host = resolved.get(port) ?? (await findHost(port, opts));
  if (!host) {
    return {
      bridged: false,
      reason: inContainer()
        ? "no-gateway (add extra_hosts: host.docker.internal:host-gateway)"
        : "unreachable",
    };
  }
  resolved.set(port, host);
  lastGoodHost = host;

  // 3) Splice container loopback -> host, rewriting Host: so the dev
  //    server's host allow-list sees `localhost`.
  const server = createBridge(port, host);
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok());
  }).catch((e: Error) => {
    throw new Error(
      `loopback bridge ${port}->${host}:${port} failed: ${e.message}`,
    );
  });
  bridge.set(port, server);
  return { bridged: true, via: host };
}

/**
 * TCP proxy that preserves the byte stream but rewrites the HTTP request
 * `Host:` header to `localhost:<port>`. WebSocket upgrades (Vite HMR) pass
 * through as raw bytes after the handshake, so HMR keeps working.
 */
function createBridge(port: number, host: string): Server {
  return createServer((client: Socket) => {
    const upstream = connect({ host, port }, () => {
      // Rewrite the head of the first upstream write only.
      let rewritten = false;
      const onData = (chunk: Buffer) => {
        if (rewritten) {
          upstream.write(chunk);
          return;
        }
        rewritten = true;
        upstream.write(rewriteHostHeader(chunk, port));
      };
      client.on("data", onData);
      client.once("end", () => upstream.end());
      client.once("error", () => upstream.destroy());
      upstream.on("data", (c: Buffer) => client.write(c));
      upstream.once("end", () => client.end());
      upstream.once("error", () => client.destroy());
    });
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
  });
}

/**
 * Replace the `Host:` line in the first HTTP request head with
 * `localhost:<port>`. Leaves everything else byte-identical.
 *
 * Exported for tests: the Vite `allowedHosts` 403 is the whole reason the
 * bridge exists, so the rewrite is worth pinning down.
 */
export function rewriteHostHeader(buf: Buffer, port: number): Buffer {
  const s = buf.toString("latin1");
  const end = s.indexOf("\r\n\r\n");
  if (end === -1) return buf; // not a complete head (TLS/handshake) — pass through
  const head = s.slice(0, end);
  const rest = s.slice(end);
  const newHead = head.replace(/^host:[^\r\n]*$/im, `Host: localhost:${port}`);
  return Buffer.from(newHead + rest, "latin1");
}

export function closeBridges(): void {
  for (const [, s] of bridge) s.close();
  bridge.clear();
  resolved.clear();
  lastGoodHost = null;
}
