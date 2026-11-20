import { MobileError } from "./errors.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Handler = (params: Record<string, unknown>) => void;

/**
 * Minimal Chrome DevTools Protocol client: one WebSocket, request/response by
 * id, events by method name. No Playwright, because Playwright cannot attach to
 * a WKWebView and depending on it would make two platforms two codebases.
 *
 * Uses the global WebSocket, present in Node 22+ and Bun, so the server has no
 * runtime dependency beyond tmcp and valibot.
 */
export class Cdp {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  private closed = false;
  private ws!: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(
          new MobileError(
            "E_CDP",
            `Invalid devtools socket URL: ${url} (${e instanceof Error ? e.message : String(e)})`,
            "Re-attach; the WebView may have restarted.",
          ),
        );
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(
          new MobileError(
            "E_CDP_TIMEOUT",
            `Devtools socket ${url} did not open in ${timeoutMs}ms.`,
            "The WebView target may have been created by a previous app run. Reload the app, then retry.",
          ),
        );
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          const cdp = new Cdp(ws);
          cdp.bind();
          resolve(cdp);
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(
            new MobileError(
              "E_CDP",
              `Cannot connect to ${url}.`,
              "Reload the app, then retry. A release build is not attachable — use a debug build.",
            ),
          );
        },
        { once: true },
      );
    });
  }

  /** Send one command and await its result. */
  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(
        new MobileError(
          "E_CDP_CLOSED",
          "Devtools socket is closed.",
          "Call act action=attach to reconnect.",
        ),
      );
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new MobileError(
            "E_CDP_TIMEOUT",
            `${method} did not answer in ${timeoutMs}ms.`,
            "The WebView is busy or blocked on a native call. Try observe kind=state, or reload.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: Handler): () => void {
    const set = this.handlers.get(method) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(method, set);
    return () => set.delete(handler);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        new MobileError(
          "E_CDP_CLOSED",
          "Devtools socket closed while the call was in flight.",
          "Re-attach with act action=attach.",
        ),
      );
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /** Wire the socket to the pending map and the event handlers. */
  bind(): void {
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(
            new MobileError(
              "E_CDP",
              msg.error.message ?? "Devtools command failed.",
              "The target rejected the command; it may not support this domain.",
            ),
          );
        } else {
          p.resolve((msg.result ?? {}) as unknown);
        }
        return;
      }
      if (msg.method) {
        const set = this.handlers.get(msg.method);
        if (!set) return;
        for (const h of set) {
          try {
            h(msg.params ?? {});
          } catch {
            // A listener must never break the socket.
          }
        }
      }
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(
          new MobileError(
            "E_CDP_CLOSED",
            "Devtools socket closed.",
            "Call act action=attach to reconnect.",
          ),
        );
      }
      this.pending.clear();
    });
  }
}
