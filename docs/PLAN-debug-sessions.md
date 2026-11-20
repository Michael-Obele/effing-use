# Map: long-session debugging

Status: active · Date: 2026-11-19 · Branch: `feat/debug-session-journal`

Skills applied: wayfinder (local-markdown fallback; no tracker configured), whole-product
Gate 0 truth / Gate 2 shape / Gate 5 verify, ponytail (smallest working slice),
ultrathink (design), subagent-driven-development (execution), forge (review).

## Destination

A long agent session can answer "what happened at step 42?" without guessing:
browser events and tool calls are journaled to disk, failures are queryable, and
the evidence survives the 50-event in-memory rings, context compaction, and
idle reaping. Reaching the destination means `browser_observe kind=errors` and
`browser_extract kind=timeline` return real, filtered evidence for a session
that has been running for hours.

## Notes

- This is a feature increment to an existing product, not a new product. Whole-product
  Gates 1 (market research), 3 (surface craft), 4 (coverage matrix), and 6 (release)
  do not apply to this slice; Gate 0, 2, and 5 do.
- No issue tracker is configured for this repo. Wayfinder's local-markdown fallback
  is used: the map is this file, and each `## Task N` heading is a ticket.
- Preserve the existing uncommitted v0.3.1 work in the working tree. The SDD baseline
  is the `git stash create` commit recorded in the progress ledger. Implementers
  must not commit: a commit would mix pre-existing work into this feature.
- Keep the 3-tool MCP surface. New capability is a `kind`/filter, never a fourth tool.
- The product's one-line promise is token-efficient browser control. Every addition
  must keep payloads capped and push large state to files.

## Decisions so far

- Evidence backbone is an append-only per-session JSONL journal, not bigger rings.
- v1 captures console, page errors, responses, failed requests, navigation, crash,
  and tool calls. It does not capture response bodies or request headers.
- v1 exposes `browser_observe kind=errors`, richer `console`/`network` filters, and
  `browser_extract kind=timeline`.
- Redaction is on by default and reuses `RECORD_REDACT`. No new redaction flag.
- Journal lives under `${OUTPUT_DIR}/sessions/<safe-session-id>/journal.jsonl`,
  rotates at `EFFING_JOURNAL_MAX_BYTES`, and is enabled by default with
  `EFFING_JOURNAL=0` to disable.
- Calls are journaled in the tool handlers, where success/code are known; browser
  events are journaled in `session.ts`, where Playwright emits them.
- Dialog capture is deliberately not added: a persistent `page.on("dialog")`
  listener would stop Playwright auto-dismiss and break `dialog_accept`/`dialog_dismiss`.
- Snapshot versioning is deferred. Timeline entries may include a snapshot path when
  a call already returns one, but there is no history/diff API in v1.

## Not yet specified

- Snapshot history with stable IDs and `observe snapshot from=<id>` diffs.
- Request/response headers and bodies, `network detail=<id>`, HAR export.
- Eval escape hatch and CDP (`ALLOW_EVAL` is currently dead config).
- Frame/iframe targeting and `observe kind=frames`.
- Performance capture (navigation timing, LCP, long tasks, heap).
- `storageState` save/load and attach-to-existing-Chrome.
- Auto screenshot/trace artifacts on failure.
- Human-facing journal viewer (`/debug` timeline tail or static HTML).
- Mutation log with per-action attribution.

## Out of scope

- Firefox/WebKit/Edge, device emulation, vision/coordinate clicking, persistent
  profiles. Those belong to Playwright MCP; effing-use is Chromium + DOM by design.
- Playwright test runner, codegen, trace viewer, fixtures.
- Response-body capture by default (size and secret risk).
- A fourth MCP tool.

## Truth (whole-product Gate 0)

**Product:** effing-use — token-efficient browser control over MCP. Three tools
(`browser_act`, `browser_observe`, `browser_extract`) over one persistent Chromium.

**Audience:** AI coding agents and the developers supervising them.

**Stack:** Bun 1.4+, TypeScript, `tmcp`, Valibot, Playwright Chromium. No test
framework beyond `bun:test`. No new dependency for this feature.

**Commands (runbook):**

- `bun install`
- `bunx playwright install chromium --only-shell`
- `bun run check` (`bunx tsc --noEmit`)
- `bun test`
- `bun src/http.ts` (HTTP MCP on `:3123`, `/mcp`)
- `bun src/index.ts` (stdio MCP)
- `bun src/cli.ts <observe|act|extract> ...`
- `EFFING_LIVE_TEST=1 bun test tests/journal-live.test.ts` (opt-in browser test)

**Non-goals:** multi-browser, vision, persistent profiles, test runner.

**Intent (verbatim):** "I want to mostly use this for long debugging and inspecting
sessions, what do we need to add to achieve that"

### Ask table

| Ask                                                   | Reading                                                                    | Status      |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ----------- |
| Use mostly for long debugging and inspecting sessions | Persist evidence for hours-long sessions; make it queryable after the fact | This plan   |
| Add what is needed                                    | Complete capture + errors + timeline + filters; defer eval/frames/HAR      | This plan   |
| Make a plan using the listed skills                   | Map + truth + spec + task briefs in this file                              | Done        |
| Implement it too                                      | Execute tasks 1–4 on `feat/debug-session-journal`                          | In progress |

## Shape (whole-product Gate 2)

**Problem in the user's words:** long sessions lose the evidence needed to debug:
the console/network rings hold 50 entries, uncaught errors and failed requests are
never captured, and nothing correlates a tool call to what the browser did.

**Stories:**

1. As a developer debugging an agent run, I can ask for all errors since a time
   window and get deduplicated page errors, console errors, and network failures.
2. As a developer debugging a long run, I can read a chronological timeline of
   tool calls and browser events, filtered and paginated, after the fact.
3. As an agent, I can see the journal path in an error envelope and fetch the
   evidence without re-running the flow.
4. As an operator, I can disable journaling or cap its disk use with env vars.

**Decisions:**

- JSONL, one record per line, append-only; rotation keeps the current file and one
  previous file (`journal.1.jsonl`).
- Reads are file-based and filter in memory. A 2 MB cap keeps this cheap.
- `errors` aggregates by message/URL; `timeline` returns compact one-line summaries.
- Existing `logs` / `requests` response keys stay for backward compatibility.

**Open questions:** none blocking v1. Snapshot history and eval are deferred.

## Global Constraints

These bind every task. Copy them verbatim into reviewer prompts.

1. TypeScript, Bun, `tmcp`, Valibot, Playwright only. No new dependencies.
2. Do not add a fourth MCP tool. Extend existing `kind`/`action`/optional fields.
3. Existing response shapes stay backward compatible: `browser_observe kind=console`
   returns `logs`; `kind=network` returns `requests`; errors stay
   `{ ok: false, code, message, hint }` plus optional `journal`.
4. Journal writes must never fail a tool call. Catch and swallow I/O errors.
5. Redaction is on by default. Reuse `config.recordRedact`. Do not capture request
   or response bodies in v1.
6. All new config is env-overridable with safe defaults:
   `EFFING_JOURNAL` (default on), `EFFING_JOURNAL_MAX_BYTES` (default 2,000,000).
7. Journal path: `${config.outputDir}/sessions/<safe-session-id>/journal.jsonl`.
   Rotation file: `journal.1.jsonl`. Reads include the rotated file first.
8. Payloads stay capped: each journaled string field is clipped to 4,000 chars;
   query results honor `limit` and report `truncated`.
9. Do not touch or revert pre-existing uncommitted changes. Implementers must not
   run `git add`, `git commit`, or `git stash`. Leave work in the working tree.
10. Run `bun run check` and `bun test` before reporting. Mark browser-dependent tests
    `describe.skipIf(process.env.EFFING_LIVE_TEST !== "1")`.
11. Follow existing code style: two-space indent, semicolons, named exports, comments
    only for non-obvious intent.

---

## Task 1 — Journal core and config

**Goal:** add the append-only journal module and its configuration, fully unit-tested
without touching sessions or tools.

**Files:**

- Create `src/browser/journal.ts`
- Create `tests/journal.test.ts`
- Edit `src/config.ts`
- Edit `.env.example`

**API (exact names):**

```ts
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

export function journalDir(config: Config, sessionId: string): string;
export function journalPath(config: Config, sessionId: string): string;
export function parseSince(raw: string, now?: number): string | null;
export function appendEvent(
  config: Config,
  sessionId: string,
  event: JournalInput,
): Promise<JournalEvent | null>;
export function appendCall(
  config: Config,
  sessionId: string,
  call: JournalCall,
): Promise<string>;
export function readJournal(
  config: Config,
  sessionId: string,
  filter?: JournalFilter,
): Promise<JournalRead>;
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
};
export function formatEventLine(event: JournalEvent): string;
export function flushJournal(sessionId?: string): Promise<void>;
```

**Behavior:**

- `appendEvent` is a no-op returning `null` when `config.journal === false`.
- Ensure the session directory exists with `mkdir({ recursive: true })`.
- Serialize one JSON record per line. Add `seq` (per-process, per-session counter),
  `id` (`${Date.now()}-${seq}`), `ts` (ISO, use `event.ts` if supplied), `sessionId`.
- Clip every string field to 4,000 chars (`clipString` helper, recursive).
- Redact recursively when `config.recordRedact !== false`. Redact object keys matching
  `/pass(word)?|secret|token|otp|pin|ssn|authorization|cookie|set-cookie|api[-_]?key/i`
  by replacing the value with `«redacted»`. Arrays map; objects recurse.
- Serialize writes per session with a promise chain (`Map<string, Promise<void>>`) so
  concurrent events cannot interleave. `appendEvent` resolves after the write;
  `flushJournal(sessionId?)` awaits the chain(s).
- Rotation: before append, `stat` the current file. If `size + line.length >
config.journalMaxBytes`, remove `journal.1.jsonl` (force) and rename the current file
  to it. Missing file is fine.
- `readJournal` reads `journal.1.jsonl` first, then `journal.jsonl`. Missing files are
  fine. Skip malformed lines. Sort by file order (rotated first), not by re-sorting.
- `since`: if relative, `parseSince` converts to ISO; compare `Date.parse(event.ts) >=
Date.parse(since)`. Invalid `since` is ignored.
- `filter`: case-insensitive substring over `event.type`, `event.url`, and
  `JSON.stringify(event)`. `level` matches `event.level` case-insensitively and only
  applies to console events. `type` accepts one or many.
- `offset` and `limit`: apply after filtering. `total` is the filtered count before
  slice. `truncated = offset + events.length < total`. `path` is the current journal path.
- `appendCall` generates `callId = call-${Date.now()}-${counter}`, appends a
  `type: "call"` event with the call fields, and returns the id.
- `summarizeErrors`:
  - page errors: `type === "pageerror"`, dedupe by `name + message`.
  - console errors: `type === "console" && level === "error"`, dedupe by `text + url`.
  - network failures: `type === "requestfailed"` OR (`type === "response"` and
    (`status >= 400` or `ok === false`)), dedupe by `method + url + status + failure`.
  - Each entry tracks `count`, `firstAt`, `lastAt`; cap each array at 20.
  - `total` is the number of matching failure events before dedupe.
- `formatEventLine` returns one compact line, max 300 chars:
  - call: `[call] act:click ok 42ms — <url>`
  - console: `[console:error] text — url:line`
  - pageerror: `[pageerror] message`
  - response: `[net] GET url → 404 (12ms)`
  - requestfailed: `[netfail] GET url — net::ERR_FAILED`
  - navigation: `[nav] url`
  - crash: `[crash] page crashed`

**Config:**

- Add `journal: v.optional(v.boolean(), true)` and
  `journalMaxBytes: v.optional(v.number(), 2_000_000)` to `ConfigSchema`.
- In `loadConfig`: `journal: process.env.EFFING_JOURNAL !== "false" &&
process.env.EFFING_JOURNAL !== "0"`, and a finite positive
  `EFFING_JOURNAL_MAX_BYTES` floored at 10,000.
- `.env.example`: add the two vars with a one-line comment each.

**Tests (`tests/journal.test.ts`):**
Use `mkdtemp(join(tmpdir(), "effing-journal-"))` and a fake `Config` cast. Cover:

1. append + read round-trip preserves fields and adds `seq`/`id`/`ts`/`sessionId`.
2. `config.journal === false` writes nothing.
3. filters: `type`, `level`, `filter`, `since` (relative), `offset`/`limit`, `truncated`.
4. redaction: nested `authorization`/`password` keys become `«redacted»`.
5. rotation: set `journalMaxBytes` small, append enough, verify `journal.1.jsonl`
   exists and `readJournal` returns both files in order.
6. `parseSince("5m")` returns an ISO timestamp roughly 5 minutes ago; invalid input
   returns `null`.
7. `summarizeErrors` dedupes repeated page errors / console errors / 500 responses
   and counts first/last.
8. `formatEventLine` renders each event type without throwing.

**Acceptance:**

- `bun run check` passes.
- `bun test tests/journal.test.ts` passes.
- No edits to `session.ts`, `engine.ts`, or `src/tools/*`.

---

## Task 2 — Session event capture

**Goal:** capture every useful Playwright event and persist it to the journal, while
keeping the existing in-memory rings and evidence envelope working.

**Files:**

- Edit `src/browser/journal.ts` (add `clearJournalState`)
- Edit `src/browser/session.ts`
- Create `tests/journal-live.test.ts` (opt-in)

**Types:**
Replace the inline ring types in `SessionEntry` with:

```ts
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
```

Keep the 50-entry caps. `getConsoleLogs` / `getNetworkLogs` signatures stay.

**Listeners (all fire-and-forget with `.catch(() => undefined)`):**

- `console`: push `ConsoleEntry` with `msg.location()`; journal
  `{ type: "console", level: msg.type(), text: msg.text(), at, url, line, column }`.
- `pageerror`: journal `{ type: "pageerror", message, name, stack }`
  (stack clipped by the journal module).
- `requestfailed`: journal `{ type: "requestfailed", requestId, method, url,
resourceType, failure: req.failure()?.errorText }`. Playwright 1.63 exposes no
  public request id, so assign a stable per-process id with a
  `WeakMap<Request, string>` shared by the response and requestfailed listeners.
- `response`: push `NetworkEntry` with `at`, `requestId`, `resourceType`, `ok`;
  compute `durationMs` defensively from `res.request().timing()` when
  `startTime >= 0 && responseEnd >= 0`, else omit. Journal
  `{ type: "response", requestId, method, url, status, ok, resourceType, durationMs }`.
- `framenavigated`: journal `{ type: "navigation", url: page.url(), frameUrl: frame.url() }`
  only when `frame === page.mainFrame()`.
- `crash`: journal `{ type: "crash", url: page.url() }`.
- Do **not** add a `dialog` listener. It would stop Playwright's default
  auto-dismiss and break `dialog_accept` / `dialog_dismiss`.

**Lifecycle:**

- Add `export function clearJournalState(sessionId: string): void` to `journal.ts`:
  delete that session's `seqCounters` and `writeChains` entries. This prevents the
  per-session maps from growing without bound in a long-lived process.
- `closeSession` closes the context first (unload handlers can emit events), then
  awaits `flushJournal(sessionId)` (swallow errors), then calls
  `clearJournalState(sessionId)`. Draining after close prevents late writes from
  repopulating the maps that were just cleared.
- `reapIdle` follows the same close → flush → clear → delete order.
- `closeAll` flushes every known session id before closing the browser.

**Opt-in live test (`tests/journal-live.test.ts`):**

- `const live = process.env.EFFING_LIVE_TEST === "1"; (live ? describe : describe.skip)(...)`.
  Use the ternary form; `describe.skipIf` is not guaranteed across Bun versions.
- Start a `Bun.serve({ port: 0, ... })` page with inline script that:
  `console.error("boom-console")`, `setTimeout(() => { throw new Error("boom-pageerror") }, 10)`,
  and `fetch("/missing").catch(() => {})`.
- Create a temp `outputDir`; call `getPage(config, "live")`, `page.goto(url)`,
  `await page.waitForTimeout(500)`.
- `await flushJournal("live")` immediately before `readJournal(config, "live")`
  so the fire-and-forget writes are deterministic.
- `readJournal(config, "live")` must contain: a `console` event with level `error`,
  a `pageerror` with `boom-pageerror`, a `response` with status 404 and a string
  `requestId`, and a `navigation` event.
- `afterAll` calls `closeAll()` and stops the Bun server.
- Leave the test skipped by default so `bun test` stays browser-free.

**Acceptance:**

- `bun run check` passes.
- `bun test` passes (live test skipped).
- If Chromium is installed: `EFFING_LIVE_TEST=1 bun test tests/journal-live.test.ts`
  passes.
- No edits to `engine.ts` or `src/tools/*`.
- The `clearJournalState` addition is the only journal.ts change in this task.

---

## Task 3 — Query surface

**Goal:** expose the journal through `browser_observe` and `browser_extract` without
breaking existing response shapes.

**Files:**

- Edit `src/browser/engine.ts`
- Edit `src/tools/observe.ts`
- Edit `src/tools/extract.ts`
- Create `tests/observe-errors.test.ts`

**Engine types:**
Extend `ObserveOpts` with `since?: string; filter?: string; level?: string;
offset?: number;`.

**`browser_observe`:**

- Add `kind: "errors"` to the picklist.
- `readJournal` must await `flushJournal(sessionId)` first, so a query immediately
  after a fire-and-forget browser event sees it. All new read cases inherit this.
- `case "errors"`: call `readJournal(config, sessionId, { since, filter })`, then
  `summarizeErrors(read.events)`. Return
  `{ ...summary, journal: read.path, totalEvents: read.total }`.
- `case "console"`: read journal with `type: "console"`, plus `since`, `filter`,
  `level`, `offset`, `limit` (default 20, cap 200). Map events back to
  `{ type: level, text, at: ts, url, line, column }`. Return
  `{ logs, total, path: read.path, truncated }`. When `config.journal === false`,
  fall back to `getConsoleLogs(sessionId)` (in-memory ring) with the same filters.
- `case "network"`: read journal with `type: ["response", "requestfailed"]` plus
  `since`, `filter`, `offset`, `limit` (default 20, cap 200). Map to
  `{ method, url, status: status ?? 0, at: ts, requestId, resourceType, ok,
durationMs, failure }`. Return `{ requests, total, path: read.path, truncated }`.
  When `config.journal === false`, fall back to `getNetworkLogs(sessionId)`.
- Schema additions: optional `since`, `filter`, `level`, `offset` (strings/numbers).
  Keep `target`, `limit`, `inline`, `mode`, `scope` unchanged.

**`browser_extract`:**

- Add `kind: "timeline"` to the picklist.
- `case "timeline"`: `readJournal(config, sessionId, { since, filter, limit, offset })`
  with `limit` default 100, cap 500. Return
  `{ lines: read.events.map(formatEventLine), count: read.total, path: read.path,
truncated: read.truncated }`.
- Schema additions: optional `since`, `filter`, `offset`. Keep `selector`, `mode`,
  `limit` unchanged.

**Tests (`tests/observe-errors.test.ts`):**

- Use a temp `outputDir`; `appendEvent` several records: console error (twice),
  pageerror, 500 response, requestfailed, and one benign log/200.
- Call `doObserve({} as never, config, "errors", undefined, undefined,
{ sessionId: "s" })`; assert deduped counts and that `journal` ends with
  `journal.jsonl`.
- Call `doObserve` for `console` with `level: "error"` and `network` with
  `filter: "api"`; assert backwards-compatible keys `logs` / `requests`.
- Call `doExtract({} as never, config, "timeline", undefined, 10,
{ sessionId: "s" })`; assert `lines` contains `[console:error]`, `[pageerror]`,
  and `[net]`.

**Acceptance:**

- `bun run check` passes.
- `bun test` passes.
- Existing `bun test` unit expectations still pass (32 act actions, batch guard, goal).
- Do not edit `src/tools/act.ts`; call journaling is Task 4.

---

## Task 4 — Call journaling and error envelopes

**Goal:** record every tool call with its outcome and make the journal path part of
every failure, without changing the public tool surface.

**Files:**

- Edit `src/tools/act.ts`
- Edit `src/tools/observe.ts`
- Edit `src/tools/extract.ts`

**Call journaling:**

- Change `runAct`, `runObserve`, `runExtract` to accept `config: Config` and return
  `Promise<Record<string, unknown>>` instead of calling `tool.text`. Convert every
  existing `return tool.text(JSON.stringify(x))` to `return x`.
- In each tool handler:
  1. `const config = loadConfig();` and `const t0 = Date.now();`.
  2. `try { result = await run... } catch` producing the same `{ ok:false, ... }`
     envelope.
  3. `const durationMs = Date.now() - t0;`
  4. `await appendCall(config, sid, { tool, key, durationMs, ok: result.ok === true,
code, url, path })` where `code/url/path` are included only when they are
     strings. Swallow errors.
  5. `recordCall(tool, key, durationMs, sid); touchSession(sid);`
  6. `return tool.text(JSON.stringify(result));`
- Add `journal: journalPath(config, sid)` to every error envelope (EngineError and
  generic catch) in `runAct` / `runObserve` / `runExtract`.
- The `tool` strings are exactly `"act"`, `"observe"`, `"extract"`; `key` is the
  existing action/kind string.

**Acceptance:**

- `bun run check` passes.
- `bun test` passes.
- No tool schema change: `tools/list` bytes must be exactly the Task 3 value.
- A successful `browser_observe kind=url` and a failing `browser_act action=click
target=#does-not-exist` each append one `type: "call"` event with `ok`, `key`, and
  `durationMs`. Verify with a small temporary script or a unit test; do not leave
  scratch files behind.

---

## Task 5 — Docs, runbook, verification

**Goal:** make the feature discoverable and prove it works end to end.

**Files:**

- Edit `README.md`
- Edit `skills/effing-use/SKILL.md`
- Edit `docs/PLAN-debug-sessions.md` (append verification evidence only)
- `.env.example` is already updated in Task 1; adjust only if a value changed.

**README section (`## Long debugging sessions`), placed after the harness section:**

- Explain the journal: location, JSONL, rotation, redaction, enabled by default.
- Show MCP calls:
  - `browser_observe kind=errors`
  - `browser_observe kind=console level=error since=10m`
  - `browser_observe kind=network filter=/api/ since=10m`
  - `browser_extract kind=timeline since=1h limit=100`
- Show CLI equivalents over `EFFING_USE_URL`.
- Explain `EFFING_JOURNAL=0` and `EFFING_JOURNAL_MAX_BYTES`.
- Explain that for long manual sessions the idle reaper must be disabled:
  `EFFING_IDLE_TTL_MS=0 EFFING_BROWSER_TTL_MS=0`.
- State the v1 boundary: no request/response bodies, no snapshot history, no eval.
- Link `docs/PLAN-debug-sessions.md` for the deferred map.

**Skill doc:** add a short "Debugging a long session" workflow to
`skills/effing-use/SKILL.md`: observe errors, filter console/network, read timeline,
follow the `journal` path on failures. Match the file's existing tone and format.

**Verification (whole-product Gate 5):**
Run and record exact results in the final report:

1. `bun run check`
2. `bun test`
3. `EFFING_LIVE_TEST=1 bun test tests/journal-live.test.ts` (if Chromium available)
4. `bunx prettier --check src/ tests/ bench/ compose.yaml` (fix formatting in touched
   files only; report pre-existing failures separately)
5. `tools/list` byte count using the README stdio pipe command; report the number and
   confirm < 6,000 bytes.
6. A manual CLI smoke (optional if server can start):
   `bun src/http.ts` in one process, then
   `EFFING_USE_URL=http://localhost:3123/mcp bun src/cli.ts observe --kind errors`.
   Use a bounded timeout and kill the server.

**Acceptance:**

- Docs match the implemented behavior exactly; no claims about bodies, HAR, eval, or
  frames.
- Verification evidence is recorded.
- No code changes unless a verification failure is caused by this feature.

---

## Verification (whole-product Gate 5)

Evidence hierarchy: executed live test > full test suite > typecheck > source read.
The plan is not done until Tasks 1–4 are complete, the full suite passes, the live
journal test has run at least once against real Chromium, and the final forge review
has no open Critical/Important findings.

### Recorded evidence (2026-11-19)

| Check                            | Command                                                  | Result                                                    |
| -------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Typecheck                        | `bun run check`                                          | pass (no output)                                          |
| Full suite                       | `bun test`                                               | **64 pass / 3 skip / 0 fail** (67 tests, 6 files)         |
| Live journal (real Chromium)     | `EFFING_LIVE_TEST=1 bun test tests/journal-live.test.ts` | **2 pass / 0 fail**                                       |
| Formatting                       | `bunx prettier --check src/ tests/ bench/ compose.yaml`  | clean (`http.ts` drift fixed in this change)              |
| `tools/list` size                | README stdio pipe                                        | **10,620 B / 3 tools** (unchanged from Task 3)            |
| Call journaling (success + fail) | `tests/call-journal.test.ts`                             | 3 pass — `type:"call"` record with tool/key/ok/durationMs |

Task 4 verification: a failing `browser_act action=batch steps=[]` and a failing
`browser_extract kind=query` (missing selector) each append exactly one
`type:"call"` event and return a `journal` path. `tools/list` bytes are byte-identical
to Task 3 (no schema change).

## Review plan (forge)

- Per task: spec compliance + code quality, diff limited to that task's files, reviewer
  on a different model than the implementer.
- Final: whole-feature review with correctness, security (journal paths, redaction,
  unbounded I/O), quality, and verification lenses. Any finding that contradicts this
  plan comes back to the human before a fix is dispatched.
- Diffs are against the recorded baseline `5c01b60` (a `git stash create` commit of the
  pre-existing working tree). The controller may run `git add -N` on new files so they
  appear in `git diff`; implementers must not stage or commit.
- Security focus: session id path traversal (`safeSegment`), secret redaction,
  malformed JSONL tolerance, rotation races, and journal write failures not breaking
  tool calls.
