#!/usr/bin/env bun
import { StdioTransport } from "@tmcp/transport-stdio";
import { server } from "./server.js";

const transport = new StdioTransport(server);
transport.listen();
