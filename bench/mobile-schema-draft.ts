// Draft of the proposed 3-tool mobile schema. Its only purpose is to measure
// `tools/list` bytes before a line of the real server exists.
import { McpServer } from "tmcp";
import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { defineTool } from "tmcp/tool";
import { tool } from "tmcp/utils";
import * as v from "valibot";
import { StdioTransport } from "@tmcp/transport-stdio";

const ACT = [
  "attach",
  "launch",
  "terminate",
  "foreground",
  "background",
  "reload",
  "open_url",
  "tap",
  "fill",
  "type",
  "press",
  "swipe",
  "scroll",
  "back",
  "wait",
  "permission",
  "deep_link",
  "push",
  "appearance",
  "locale",
  "orientation",
  "network",
  "route",
  "sync",
  "note",
  "batch",
  "eval",
] as const;

const OBSERVE = [
  "snapshot",
  "screenshot",
  "url",
  "title",
  "console",
  "network",
  "errors",
  "logs",
  "crash",
  "plugins",
  "device",
  "apps",
  "frames",
  "keyboard",
  "perf",
  "storage",
  "state",
  "timeline",
] as const;

const EXTRACT = [
  "text",
  "html",
  "table",
  "query",
  "pdf",
  "trace_start",
  "trace_stop",
  "har",
] as const;

const Step = v.object({
  action: v.picklist(ACT),
  target: v.optional(v.string()),
  value: v.optional(v.string()),
});

const act = defineTool(
  {
    name: "mobile_act",
    description:
      "Drive the device: attach/launch/terminate the app, tap/fill/type/press/swipe/scroll, back, wait, open URLs and deep links, grant/revoke permissions, send push, set appearance/locale/orientation, throttle or route network, sync Capacitor assets, note, eval, or run a batch. Targets accept snapshot e-refs, CSS, or role/name. Returns a capped JSON effect summary.",
    schema: v.object({
      action: v.picklist(ACT),
      target: v.optional(v.string()),
      value: v.optional(v.string()),
      sessionId: v.optional(v.string()),
      steps: v.optional(v.array(Step)),
      expect: v.optional(v.string()),
      approve: v.optional(v.boolean()),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async () => tool.text("{}"),
);

const observe = defineTool(
  {
    name: "mobile_observe",
    description:
      "Read device and app state without changing it: snapshot (element refs), delta snapshot, screenshot (file path), url, title, console, network, errors, native logs, crash, Capacitor plugin calls, device, apps, frames, keyboard, perf, storage, state, timeline. Snapshot before act to get refs.",
    schema: v.object({
      kind: v.picklist(OBSERVE),
      target: v.optional(v.string()),
      limit: v.optional(v.number()),
      since: v.optional(v.string()),
      filter: v.optional(v.string()),
      sessionId: v.optional(v.string()),
      inline: v.optional(v.boolean()),
      mode: v.optional(v.picklist(["full", "delta"])),
      scope: v.optional(v.string()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => tool.text("{}"),
);

const extract = defineTool(
  {
    name: "mobile_extract",
    description:
      "Pull structured data out of the app: rendered text, HTML, table rows as JSON, CSS query, PDF, HAR, or trace start/stop. Large results go to a file path with a capped preview. Prefer over snapshot for scraping.",
    schema: v.object({
      kind: v.picklist(EXTRACT),
      selector: v.optional(v.string()),
      mode: v.optional(v.string()),
      limit: v.optional(v.number()),
      since: v.optional(v.string()),
      sessionId: v.optional(v.string()),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => tool.text("{}"),
);

const server = new McpServer(
  { name: "effing-use-mobile-draft", version: "0.0.0" },
  {
    adapter: new ValibotJsonSchemaAdapter(),
    capabilities: { tools: { listChanged: true } },
  },
);
await server.tools([act, observe, extract]);

const transport = new StdioTransport(server);
transport.listen();
