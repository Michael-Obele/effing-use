import { McpServer } from "tmcp";
import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { MOBILE_VERSION } from "./config.js";
import { actTool } from "./tools/act.js";
import { observeTool } from "./tools/observe.js";
import { extractTool } from "./tools/extract.js";

const adapter = new ValibotJsonSchemaAdapter();

export const mobileServer = new McpServer(
  {
    name: "effing-use-mobile",
    version: MOBILE_VERSION,
    description:
      "Token-efficient Android/Capacitor control: 3 tools (act, observe, extract) over adb + the WebView devtools protocol.",
  },
  { adapter, capabilities: { tools: { listChanged: true } } },
);

mobileServer.tools([actTool, observeTool, extractTool]);
