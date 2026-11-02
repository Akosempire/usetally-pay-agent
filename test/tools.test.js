import test from "node:test";
import assert from "node:assert/strict";
import { demoClient } from "../src/paypal.js";
import { runTool, toolSchemas, moneySummary } from "../src/tools.js";

test("every tool has a JSON schema a model API accepts", () => {
  const s = toolSchemas();
  assert.equal(s.length, 8);
  for (const t of s) { assert.equal(t.input_schema.type, "object"); assert.equal(t.input_schema.$schema, undefined); assert.ok(t.description.length > 20); }
  assert.deepEqual(s.find((t) => t.name === "create_invoice").input_schema.required, ["customer_name", "items"]);
});

test("tools: draft, list overdue, remind, record, summary", async () => {
  const ctx = { paypal: demoClient() };
  const made = await runTool("create_invoice", { customer_name: "Kofi Mensah", items: [{ name: "Consulting", quantity: 3, unit_price: 100 }], tax_percent: 10 }, ctx);
  assert.equal(made.invoice.status, "DRAFT"); assert.equal(made.invoice.total, 330);
  const overdue = await runTool("list_invoices", { filter: "overdue" }, ctx);
  assert.equal(overdue.count, 1); assert.equal(overdue.invoices[0].customer, "Northwind Studio");
  const reminded = await runTool("remind_invoice", { invoice_id: overdue.invoices[0].id, note: "Gentle nudge" }, ctx);
  assert.equal(reminded.reminded, true);
  const tooMuch = await runTool("record_payment", { invoice_id: overdue.invoices[0].id, amount: 99999 }, ctx);
  assert.match(tooMuch.error, /more than the USD 1800.00/);
  await runTool("record_payment", { invoice_id: overdue.invoices[0].id, amount: 800 }, ctx);
  const { totals } = await runTool("money_summary", {}, ctx);
  assert.deepEqual(totals, [{ currency: "USD", owed: 1850, overdue: 1000, overdue_count: 1, collected: 1200 }]);
});

test("bad input and PayPal errors never throw", async () => {
  const ctx = { paypal: demoClient() };
  assert.match((await runTool("create_invoice", { customer_name: "" }, ctx)).error, /customer_name|items/);
  assert.match((await runTool("get_invoice", { invoice_id: "INV2-NOPE" }, ctx)).error, /No invoice/);
  assert.match((await runTool("nope", {}, ctx)).error, /Unknown tool/);
});

test("money summary skips drafts and cancelled invoices", () => {
  const t = moneySummary([{ status: "DRAFT", currency: "USD", amount_due: 50, paid: 0 }, { status: "SENT", currency: "GBP", amount_due: 20, paid: 0, due_date: "2000-01-01" }]);
  assert.deepEqual(t, [{ currency: "GBP", owed: 20, overdue: 20, overdue_count: 1, collected: 0 }]);
});
