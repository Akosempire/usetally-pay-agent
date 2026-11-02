import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3917;
let proc;
test.before(async () => {
  proc = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT: String(PORT), PAYPAL_CLIENT_ID: "", ANTHROPIC_API_KEY: "", ACCESS_KEY: "" }, stdio: "pipe" });
  await new Promise((ok) => proc.stdout.on("data", (d) => String(d).includes("Usetally Pay Agent") && ok()));
});
test.after(() => proc.kill());
const base = `http://localhost:${PORT}`;
const mcp = (body) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }).then((r) => r.json());

test("MCP: initialize, list tools, call a tool", async () => {
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.result.serverInfo.name, "usetally-pay-agent");
  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.result.tools.length, 8);
  const call = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_invoice", arguments: { customer_name: "Judge", items: [{ name: "Demo", quantity: 1, unit_price: 42 }] } } });
  assert.equal(call.result.structuredContent.invoice.total, 42);
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.equal(state.mode, "demo");
  assert.ok(state.invoices.some((i) => i.customer === "Judge"), "the dashboard sees what MCP made");
  assert.equal(state.activity[0].source, "mcp");
});

test("demo pay page marks the invoice paid", async () => {
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  const open = state.invoices.find((i) => i.status === "SENT");
  assert.match(await fetch(`${base}/demo/pay/${open.id}`).then((r) => r.text()), /Pay with PayPal/);
  const paid = await fetch(`${base}/demo/pay/${open.id}`, { method: "POST" }).then((r) => r.json());
  assert.equal(paid.invoice.status, "PAID");
});

test("webhooks without a verified signature are refused", async () => {
  const r = await fetch(`${base}/webhooks/paypal`, { method: "POST", body: "{}" });
  assert.equal(r.status, 400);
});
