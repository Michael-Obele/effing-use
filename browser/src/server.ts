import { McpServer } from "tmcp";
import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { VERSION } from "./config.js";
import { actTool } from "./tools/act.js";
import { observeTool } from "./tools/observe.js";
import { extractTool } from "./tools/extract.js";

const adapter = new ValibotJsonSchemaAdapter();

export const server = new McpServer(
  {
    name: "effing-use",
    version: VERSION,
    description:
      "Token-efficient browser control: 3 tools (act, observe, extract).",
  },
  { adapter, capabilities: { tools: { listChanged: true } } },
);

server.tools([actTool, observeTool, extractTool]);
