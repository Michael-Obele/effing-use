import type { Cdp } from "./cdp.js";
import { MobileError } from "./errors.js";
import { RUNTIME } from "./runtime.js";

/**
 * Evaluate one runtime call inside the page and return its JSON-decoded value.
 *
 * The expression is wrapped so three failure modes stay distinguishable:
 * the runtime is gone (reload), the script threw, or CDP itself failed. Without
 * that, a missing runtime looks like a successful empty result.
 */
export async function call<T>(
  cdp: Cdp,
  fn: string,
  args: unknown[] = [],
  timeoutMs?: number,
): Promise<T> {
  const argList = args.map((a) => JSON.stringify(a ?? null)).join(",");
  const expr =
    "(()=>{var w=window;if(!w.__effing)return JSON.stringify({missing:true});" +
    "try{return JSON.stringify(w.__effing." +
    fn +
    "(" +
    argList +
    "))}catch(e){return JSON.stringify({threw:String((e&&e.message)||e)})}})()";
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  const raw = (res as { result?: { value?: unknown } }).result?.value;
  if (typeof raw !== "string") {
    const detail = (res as { exceptionDetails?: { text?: string } })
      .exceptionDetails?.text;
    throw new MobileError(
      "E_PAGE",
      `The app did not answer ${fn}()${detail ? `: ${detail}` : "."}`,
      "Call observe kind=state, then act action=reload if the page is wedged.",
    );
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.missing) throw runtimeGone();
  if (parsed.threw) {
    throw new MobileError(
      "E_PAGE",
      `${fn}() threw: ${String(parsed.threw)}`,
      "The app's own script threw; observe kind=errors for the console trail.",
    );
  }
  return parsed as T;
}

function runtimeGone(): MobileError {
  return new MobileError(
    "E_RUNTIME",
    "The snapshot runtime is not installed on the page.",
    "Retry: it is re-injected automatically after a reload.",
  );
}

export async function injectRuntime(cdp: Cdp): Promise<void> {
  await cdp.send("Page.enable").catch(() => undefined);
  await cdp.send("Runtime.enable").catch(() => undefined);
  // Re-installed on every document, so a reload or a client-side navigation
  // does not leave later calls without __effing.
  await cdp
    .send("Page.addScriptToEvaluateOnNewDocument", { source: RUNTIME })
    .catch(() => undefined);
  await cdp
    .send("Runtime.evaluate", { expression: RUNTIME, returnByValue: true })
    .catch(() => undefined);
}

/**
 * Run a call, injecting the runtime once if the page has none. A reload is the
 * common cause: the target survives, its JS globals do not.
 */
export async function callWithRuntime<T>(
  cdp: Cdp,
  fn: string,
  args: unknown[] = [],
  timeoutMs?: number,
): Promise<T> {
  try {
    return await call<T>(cdp, fn, args, timeoutMs);
  } catch (e) {
    if (e instanceof MobileError && e.code === "E_RUNTIME") {
      await injectRuntime(cdp);
      return await call<T>(cdp, fn, args, timeoutMs);
    }
    throw e;
  }
}

/** Human-readable one-liner for a console argument list. */
export function formatConsoleArgs(
  args: Array<{ value?: unknown; description?: string; type?: string }>,
): string {
  return args
    .map((a) =>
      a.value !== undefined
        ? typeof a.value === "string"
          ? a.value
          : JSON.stringify(a.value)
        : (a.description ?? a.type ?? ""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}
