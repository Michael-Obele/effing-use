import { McpServer } from "tmcp";
import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { actTool } from "./tools/act.js";
import { observeTool } from "./tools/observe.js";
import { extractTool } from "./tools/extract.js";

const adapter = new ValibotJsonSchemaAdapter();

export const server = new McpServer(
  {
    name: "effing-use",
    version: "0.1.0",
    description:
      "Token-efficient browser control: 3 tools (act, observe, extract).",
  },
  { adapter, capabilities: { tools: { listChanged: true } } },
);

server.tools([actTool, observeTool, extractTool]);
