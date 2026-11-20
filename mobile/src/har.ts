import type { NetEntry } from "./session.js";
import { MOBILE_VERSION } from "./config.js";

/**
 * HAR 1.2 from the CDP network ring.
 *
 * Timings are honest about what the protocol gives us: total duration is
 * measured, the send/receive split is not, so it stays in `wait`. No bodies —
 * capturing them would mean buffering every response in the app.
 */
export function buildHar(
  entries: NetEntry[],
  pageUrl: string,
): Record<string, unknown> {
  return {
    log: {
      version: "1.2",
      creator: { name: "effing-use-mobile", version: MOBILE_VERSION },
      pages: [
        {
          startedDateTime: new Date().toISOString(),
          id: "page_1",
          title: pageUrl,
          pageTimings: {},
        },
      ],
      entries: entries.map((e) => ({
        startedDateTime: new Date().toISOString(),
        time: e.ms ?? 0,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: "HTTP/2",
          headers: [],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: e.status ?? 0,
          statusText: "",
          httpVersion: "HTTP/2",
          headers: [],
          cookies: [],
          content: { size: 0, mimeType: "" },
          redirectURL: "",
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: e.ms ?? 0, receive: 0 },
        ...(e.error ? { _error: e.error } : {}),
      })),
    },
  };
}
