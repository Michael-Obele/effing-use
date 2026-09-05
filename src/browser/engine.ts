import type { Page, BrowserContext } from "playwright";
import type { Config } from "../config.js";
import { EngineError, resolveLocator } from "./refs.js";
import { cap, saveText, stamp } from "./output.js";
import { getConsoleLogs, getNetworkLogs, closeSession } from "./session.js";

export type ActAction =
  | "open"
  | "goto"
  | "click"
  | "dblclick"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "hover"
  | "drag"
  | "upload"
  | "scroll"
  | "back"
  | "forward"
  | "reload"
  | "wait"
  | "dialog_accept"
  | "dialog_dismiss"
  | "close"
  | "goal"
  | "batch"
  | "tab_new"
  | "tab_select"
  | "tab_close"
  | "resize";

export interface ActOpts {
  context?: BrowserContext;
  sessionId?: string;
}

export interface ObserveOpts {
  context?: BrowserContext;
  sessionId?: string;
}

function timeoutOf(config: Config): number {
  return config.timeoutMs;
}

async function liteState(page: Page): Promise<{ url: string; title: string }> {
  return { url: page.url(), title: await page.title().catch(() => "") };
}

function toEngineError(e: unknown, fallbackHint: string): EngineError {
  if (e instanceof EngineError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const isTimeout =
    /timeout|exceeded|waiting/i.test(msg) ||
    (e as { name?: string })?.name === "TimeoutError";
  return new EngineError(
    isTimeout ? "E_TIMEOUT" : "E_BAD_INPUT",
    msg,
    fallbackHint,
  );
}

// ---------------------------------------------------------------- act

export async function doAct(
  page: Page,
  config: Config,
  action: ActAction,
  target?: string,
  value?: string,
  opts?: ActOpts,
): Promise<Record<string, unknown>> {
  const timeout = timeoutOf(config);
  try {
    switch (action) {
      case "open":
      case "goto": {
        const url = value ?? target;
        if (!url)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing URL.",
            "Pass the URL in value (or target).",
          );
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        return { ...(await liteState(page)) };
      }
      case "click": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target);
        const button =
          (value as "left" | "middle" | "right" | undefined) ?? "left";
        await loc.click({ button, timeout });
        return { ...(await liteState(page)) };
      }
      case "dblclick": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target);
        await loc.dblclick({ timeout });
        return { ...(await liteState(page)) };
      }
      case "fill": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target);
        await loc.fill(value ?? "", { timeout });
        return { ...(await liteState(page)) };
      }
      case "type": {
        await page.keyboard.type(value ?? "", { delay: 0 });
        return { ...(await liteState(page)) };
      }
      case "press": {
        if (!value)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing key.",
            "Pass a key like Enter, Tab, Escape in value.",
          );
        await page.keyboard.press(value);
        return { ...(await liteState(page)) };
      }
      case "select": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass a select element ref in target.",
          );
        const loc = await resolveLocator(page, target);
        await loc.selectOption(value ?? "", { timeout });
        return { ...(await liteState(page)) };
      }
      case "check": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass a checkbox ref in target.",
          );
        const loc = await resolveLocator(page, target);
        await loc.check({ timeout });
        return { ...(await liteState(page)) };
      }
      case "uncheck": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass a checkbox ref in target.",
          );
        const loc = await resolveLocator(page, target);
        await loc.uncheck({ timeout });
        return { ...(await liteState(page)) };
      }
      case "hover": {
        if (!target)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing target.",
            "Pass an e-ref, role= selector, or CSS.",
          );
        const loc = await resolveLocator(page, target);
        await loc.hover({ timeout });
        return { ...(await liteState(page)) };
      }
      case "drag": {
        if (!target || !value)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing drag endpoints.",
            "Pass start ref in target and end ref in value.",
          );
        const start = await resolveLocator(page, target);
        const end = await resolveLocator(page, value);
        await start.dragTo(end, { timeout });
        return { ...(await liteState(page)) };
      }
      case "upload": {
        const files = (value ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (files.length === 0)
          throw new EngineError(
            "E_BAD_INPUT",
            "Missing files.",
            "Pass comma-separated file paths in value.",
          );
        await page.setInputFiles("input[type=file]", files, { timeout });
        return { ...(await liteState(page)), files };
      }
      case "scroll": {
        const dir = (target ?? "").toLowerCase();
        if (dir === "up") await page.mouse.wheel(0, -500);
        else if (dir === "down") await page.mouse.wheel(0, 500);
        else if (dir === "top")
          await page.evaluate(() => window.scrollTo(0, 0));
        else if (dir === "bottom")
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
          );
        else if (target) {
          const loc = await resolveLocator(page, target);
          await loc.scrollIntoViewIfNeeded({ timeout });
        } else {
          await page.mouse.wheel(0, 500);
        }
        return { ...(await liteState(page)) };
      }
      case "back":
        await page
          .goBack({ waitUntil: "domcontentloaded", timeout })
          .catch(() => null);
        return { ...(await liteState(page)) };
      case "forward":
        await page
          .goForward({ waitUntil: "domcontentloaded", timeout })
          .catch(() => null);
        return { ...(await liteState(page)) };
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout });
        return { ...(await liteState(page)) };
      case "wait": {
        const t = target ?? "";
        const msMatch = /^ms:(\d+)$/.exec(t);
        if (msMatch) {
          await page.waitForTimeout(Number(msMatch[1]));
          return { ...(await liteState(page)), waited: t };
        }
        const textMatch = /^text:(.+)$/.exec(t);
        if (textMatch) {
          await page.getByText(textMatch[1]).first().waitFor({ timeout });
          return { ...(await liteState(page)), waited: t };
        }
        if (t) {
          const loc = await resolveLocator(page, t);
          await loc.waitFor({ timeout });
          return { ...(await liteState(page)), waited: t };
        }
        await page.waitForTimeout(500);
        return { ...(await liteState(page)) };
      }
      case "dialog_accept":
        page.once("dialog", (d) => void d.accept(value));
        return { armed: true };
      case "dialog_dismiss":
        page.once("dialog", (d) => void d.dismiss());
        return { armed: true };
      case "resize": {
        const m = /^(\d+)x(\d+)$/.exec(value ?? "");
        if (!m)
          throw new EngineError(
            "E_BAD_INPUT",
            `Bad size "${value}".`,
            "Use WIDTHxHEIGHT, e.g. 1280x800.",
          );
        await page.setViewportSize({
          width: Number(m[1]),
          height: Number(m[2]),
        });
        return { ...(await liteState(page)), viewport: value };
      }
      case "tab_new": {
        if (!opts?.context)
          throw new EngineError(
            "E_NO_PAGE",
            "No context.",
            "Retry the call; session context is attached server-side.",
          );
        const p = await opts.context.newPage();
        if (value ?? target)
          await p.goto((value ?? target)!, {
            waitUntil: "domcontentloaded",
            timeout,
          });
        return { url: p.url(), tabs: opts.context.pages().map((x) => x.url()) };
      }
      case "tab_select": {
        if (!opts?.context)
          throw new EngineError(
            "E_NO_PAGE",
            "No context.",
            "Retry the call; session context is attached server-side.",
          );
        const i = Number(target ?? value ?? 0);
        const pages = opts.context.pages();
        if (!pages[i])
          throw new EngineError(
            "E_BAD_INPUT",
            `No tab at index ${i}.`,
            "Call browser_observe kind=tabs for the tab list.",
          );
        await pages[i].bringToFront();
        return { url: pages[i].url() };
      }
      case "tab_close": {
        if (!opts?.context)
          throw new EngineError(
            "E_NO_PAGE",
            "No context.",
            "Retry the call; session context is attached server-side.",
          );
        const pages = opts.context.pages();
        const raw = target ?? value;
        const i = raw == null || raw === "" ? pages.length - 1 : Number(raw);
        if (!pages[i])
          throw new EngineError(
            "E_BAD_INPUT",
            `No tab at index ${i}.`,
            "Call browser_observe kind=tabs for the tab list.",
          );
        await pages[i].close();
        return { closed: i, tabs: opts.context.pages().map((x) => x.url()) };
      }
      case "close":
        await closeSession(opts?.sessionId ?? "default");
        return { closed: true };
      case "goal":
        return doGoal(page, config, value ?? target ?? "", opts);
      case "batch":
        throw new EngineError(
          "E_BAD_INPUT",
          "Use steps[] for batch.",
          "Pass steps[] array; the tool handler runs doBatch.",
        );
      default:
        throw new EngineError(
          "E_BAD_INPUT",
          `Unknown action "${action}".`,
          "See browser_act schema for valid actions.",
        );
    }
  } catch (e) {
    throw toEngineError(
      e,
      "Retry with a fresh snapshot ref, or re-observe state.",
    );
  }
}

// ---------------------------------------------------------------- goal

export async function doGoal(
  page: Page,
  config: Config,
  goal: string,
  opts?: ActOpts,
): Promise<Record<string, unknown>> {
  const g = goal.trim();
  // add-todo planner
  let m = /add\s+todo\s+(.+)/i.exec(g);
  if (m) {
    const text = m[1].replace(/^["']|["']$/g, "");
    const box = page
      .getByPlaceholder(/new\s*todo|what needs|add.*todo/i)
      .or(page.locator("input.new-todo, #new-todo, input[placeholder]"));
    if ((await box.count()) > 0) {
      await box.first().fill(text, { timeout: timeoutOf(config) });
      await page.keyboard.press("Enter");
      return { planned: "add-todo", ...(await liteState(page)) };
    }
    return {
      planned: "add-todo",
      ...(await liteState(page)),
      note: "No todo input found; fill the new-todo field manually.",
    };
  }
  // search planner: "search SITE for QUERY"
  m = /search\s+(.+?)\s+for\s+(.+)/i.exec(g);
  if (m) {
    const query = m[2].replace(/^["']|["']$/g, "");
    const box = page
      .getByRole("searchbox")
      .or(page.getByRole("textbox"))
      .or(
        page.locator("input[type=search], input[name=q], input[name=search]"),
      );
    if ((await box.count()) > 0) {
      await box.first().fill(query, { timeout: timeoutOf(config) });
      await page.keyboard.press("Enter");
      return { planned: "search", ...(await liteState(page)) };
    }
  }
  throw new EngineError(
    "E_GOAL_UNCLEAR",
    `Cannot plan goal "${g}".`,
    "Use explicit act calls instead.",
    {
      suggestedSteps: [
        { action: "open", value: "https://example.com" },
        { action: "click", target: "e0" },
        { action: "fill", target: "e1", value: "text" },
      ],
    },
  );
}

// ---------------------------------------------------------------- batch

export async function doBatch(
  page: Page,
  config: Config,
  steps: Array<{ action: ActAction; target?: string; value?: string }>,
  opts?: ActOpts,
): Promise<Record<string, unknown>> {
  if (steps.length > 20)
    throw new EngineError(
      "E_BAD_INPUT",
      "Too many steps (max 20).",
      "Split into smaller batches.",
    );
  const results: Array<Record<string, unknown>> = [];
  let failIndex: number | undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      const r = await doAct(page, config, s.action, s.target, s.value, opts);
      results.push({ ok: true, ...r });
    } catch (e) {
      const err = toEngineError(
        e,
        "Fix this step then re-run remaining steps.",
      );
      results.push({
        ok: false,
        code: err.code,
        message: err.message,
        hint: err.hint,
      });
      failIndex = i;
      break;
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return failIndex === undefined
    ? { results, okCount }
    : { results, okCount, failIndex };
}

// ---------------------------------------------------------------- observe

export async function doObserve(
  page: Page,
  config: Config,
  kind: string,
  target?: string,
  limit?: number,
  opts?: ObserveOpts,
): Promise<Record<string, unknown>> {
  const sessionId = opts?.sessionId ?? "default";
  switch (kind) {
    case "url":
      return { url: page.url() };
    case "title":
      return { title: await page.title().catch(() => ""), url: page.url() };
    case "snapshot": {
      const yaml = await buildSnapshot(page);
      const path = await saveText(config, stamp("snapshot", "yaml"), yaml);
      const { text, truncated } = cap(yaml, config.outputMaxChars);
      return {
        path,
        summary: text,
        truncated,
        url: page.url(),
        title: await page.title().catch(() => ""),
      };
    }
    case "screenshot": {
      const full = (target ?? "") === "full" || (target ?? "") === "";
      const filename = stamp("shot", "png");
      const { mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(config.outputDir, { recursive: true });
      const path = join(config.outputDir, filename);
      await page.screenshot({ path, fullPage: full });
      return { path, url: page.url() };
    }
    case "console": {
      const logs = getConsoleLogs(sessionId);
      const n = limit ?? 20;
      return { logs: logs.slice(-n) };
    }
    case "network": {
      const logs = getNetworkLogs(sessionId);
      const n = limit ?? 20;
      return { requests: logs.slice(-n) };
    }
    case "tabs": {
      const ctx = opts?.context ?? page.context();
      return { tabs: ctx.pages().map((p) => p.url()) };
    }
    case "focused": {
      const html = await page.evaluate(
        () => document.activeElement?.outerHTML?.slice(0, 2000) ?? "(none)",
      );
      const { text, truncated } = cap(html, config.outputMaxChars);
      return { focused: text, truncated };
    }
    default:
      throw new EngineError(
        "E_BAD_INPUT",
        `Unknown observe kind "${kind}".`,
        "Valid: snapshot, screenshot, url, title, console, network, tabs, focused.",
      );
  }
}

async function buildSnapshot(page: Page): Promise<string> {
  const header = [
    "# Snapshot — refs are nth-match: eN = Nth match of (button, a, input, select, textarea, [role=button], [tabindex]) in DOM order.",
    `# url: ${page.url()}`,
  ].join("\n");
  const items = await page.evaluate(() => {
    const els = [
      ...document.querySelectorAll(
        "button, a, input, select, textarea, [role=button], [tabindex]",
      ),
    ];
    return els.slice(0, 200).map((el) => {
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80);
      const aria = el.getAttribute("aria-label") ?? "";
      const name = el.getAttribute("name") ?? "";
      const id = el.getAttribute("id") ?? "";
      const extra = [
        aria && `aria="${aria}"`,
        name && `name="${name}"`,
        id && `id="${id}"`,
      ]
        .filter(Boolean)
        .join(" ");
      return `${tag} "${text}"${extra ? " " + extra : ""}`;
    });
  });
  const lines = items.map((line, i) => `[e${i}] ${line}`);
  return `${header}\n${lines.join("\n") || "(no interactive elements)"}`;
}

// ---------------------------------------------------------------- extract

export async function doExtract(
  page: Page,
  config: Config,
  kind: string,
  selector?: string,
  limit?: number,
  opts?: ObserveOpts,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case "text": {
      const text = selector
        ? ((await page
            .locator(selector)
            .first()
            .innerText()
            .catch(() => "")) as string)
        : ((await page.innerText("body").catch(() => "")) as string);
      const path = await saveText(config, stamp("text", "txt"), text);
      const { text: preview, truncated } = cap(text, config.outputMaxChars);
      return { path, preview, truncated };
    }
    case "html": {
      const html = selector
        ? ((await page
            .locator(selector)
            .first()
            .evaluate((el) => el.outerHTML)
            .catch(() => "")) as string)
        : ((await page.content().catch(() => "")) as string);
      const path = await saveText(config, stamp("page", "html"), html);
      const { text: preview, truncated } = cap(html, config.outputMaxChars);
      return { path, preview, truncated };
    }
    case "table": {
      const rows = (await page
        .locator(selector ?? "table")
        .first()
        .evaluate((table: Element) =>
          [...table.querySelectorAll("tr")].map((tr) =>
            [...tr.querySelectorAll("th,td")].map((c) =>
              (c.textContent ?? "").trim(),
            ),
          ),
        )
        .catch(() => [] as string[][])) as string[][];
      const sliced = rows.slice(0, Math.min(limit ?? 100, 100));
      const text = JSON.stringify(sliced);
      const path = await saveText(
        config,
        stamp("table", "json"),
        JSON.stringify(sliced, null, 2),
      );
      const { text: preview, truncated } = cap(text, config.outputMaxChars);
      return { path, rows: sliced, rowCount: rows.length, preview, truncated };
    }
    case "query": {
      // Routed by the extract tool to doQuery(); unreachable here.
      throw new EngineError(
        "E_BAD_INPUT",
        "Use selector + mode for query.",
        "Pass a CSS selector in selector and mode text|href|json.",
      );
    }
    case "pdf": {
      const filename = stamp("page", "pdf");
      const { mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(config.outputDir, { recursive: true });
      const path = join(config.outputDir, filename);
      await page.pdf({ path }).catch(() => {
        throw new EngineError(
          "E_BAD_INPUT",
          "PDF failed (Chromium/headless required).",
          "Run headless Chromium; headed browsers may not support page.pdf.",
        );
      });
      return { path };
    }
    case "trace_start": {
      const ctx = opts?.context ?? page.context();
      const filename = stamp("trace", "zip");
      const { join } = await import("node:path");
      const path = join(config.outputDir, filename);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(config.outputDir, { recursive: true });
      await ctx.tracing.start({ screenshots: true, snapshots: true });
      (ctx as unknown as { __tracePath?: string }).__tracePath = path;
      return { started: true, path };
    }
    case "trace_stop": {
      const ctx = opts?.context ?? page.context();
      const saved =
        (ctx as unknown as { __tracePath?: string }).__tracePath ??
        `${config.outputDir}/trace.zip`;
      await ctx.tracing.stop({ path: saved });
      return { path: saved };
    }
    default:
      throw new EngineError(
        "E_BAD_INPUT",
        `Unknown extract kind "${kind}".`,
        "Valid: text, html, table, query, pdf, trace_start, trace_stop.",
      );
  }
}

/** CSS query with text|href|json mode — kept separate so doExtract keeps the plan's 5-arg signature. */
export async function doQuery(
  page: Page,
  config: Config,
  selector: string,
  mode = "text",
  limit = 50,
): Promise<Record<string, unknown>> {
  const items = await page
    .locator(selector)
    .evaluateAll((els: Element[], m: string) =>
      els.map((el) => {
        if (m === "href")
          return (
            (el as HTMLAnchorElement).href ?? el.getAttribute("href") ?? ""
          );
        if (m === "json")
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? "").trim().slice(0, 200),
            html: el.outerHTML.slice(0, 500),
          };
        return (el.textContent ?? "").trim().slice(0, 500);
      }),
    )
    .catch(() => [] as unknown[]);
  const sliced = (items as unknown[]).slice(0, limit);
  const text = JSON.stringify(sliced);
  const path = await saveText(
    config,
    stamp("query", "json"),
    JSON.stringify(sliced, null, 2),
  );
  const { text: preview, truncated } = cap(text, config.outputMaxChars);
  return {
    path,
    items: sliced,
    count: (items as unknown[]).length,
    preview,
    truncated,
  };
}
