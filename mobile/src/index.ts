#!/usr/bin/env bun
import { StdioTransport } from "@tmcp/transport-stdio";
import { mobileServer } from "./server.js";

const transport = new StdioTransport(mobileServer);
transport.listen();
