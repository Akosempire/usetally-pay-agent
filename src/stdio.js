#!/usr/bin/env node
// For Claude Desktop, Claude Code, Cursor and other local MCP clients:
//   { "command": "node", "args": ["/path/to/src/stdio.js"], "env": { "PAYPAL_CLIENT_ID": "…", "PAYPAL_CLIENT_SECRET": "…" } }
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { paypalFromEnv } from "./config.js";

const server = createMcpServer({ paypal: paypalFromEnv() });
await server.connect(new StdioServerTransport());
