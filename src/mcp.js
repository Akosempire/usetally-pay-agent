// The MCP server: ChatGPT, Claude, Grok, Cursor and any MCP client can use
// the agent's tools. Stateless Streamable HTTP (src/server.js) or stdio (src/stdio.js).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, runTool } from "./tools.js";

export const INSTRUCTIONS = `Usetally Pay Agent: invoices paid through PayPal, for freelancers and small businesses.
- Amounts are normal amounts in the invoice currency (150 = 150.00). PayPal doesn't support every currency (for example not NGN); suggest USD, GBP, EUR or CAD.
- create_invoice only makes a draft. Show the customer, items and total, then ask before send_invoice.
- Ask before remind_invoice, record_payment and cancel_invoice. Write reminder notes yourself: short, warm, firmer the later it is.
- Share the pay_link with the person when it helps; their customer can pay by PayPal, card or Venmo.`;

export function createMcpServer(ctx) {
  const server = new McpServer({ name: "usetally-pay-agent", title: "Usetally Pay Agent", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: t.annotations }, async (input) => {
      const out = await runTool(t.name, input, ctx);
      ctx.onEvent?.({ source: "mcp", tool: t.name, ok: !out.error, invoice: out.invoice || null });
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, ...(out.error ? { isError: true } : {}) };
    });
  }
  return server;
}
