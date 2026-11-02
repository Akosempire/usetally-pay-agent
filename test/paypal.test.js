import test from "node:test";
import assert from "node:assert/strict";
import { invoiceBody, paypalClient, summarize, demoClient, totalOf } from "../src/paypal.js";

test("invoiceBody: the shape PayPal's Invoicing API v2 expects", () => {
  const b = invoiceBody({ customer_name: "Maya Chen", customer_email: "maya@x.example", customer_company: "Northwind", currency: "usd",
    items: [{ name: "Logo concept", quantity: 2, unit_price: 600 }], tax_percent: 7.5, tax_name: "VAT", due_in_days: 10, note: "Thanks!" },
    { invoiceNumber: "0042", today: new Date("2026-11-02T10:00:00Z") });
  assert.equal(b.detail.currency_code, "USD");
  assert.equal(b.detail.invoice_number, "0042");
  assert.equal(b.detail.invoice_date, "2026-11-02");
  assert.deepEqual(b.detail.payment_term, { due_date: "2026-11-12" });
  assert.deepEqual(b.primary_recipients[0].billing_info, { name: { given_name: "Maya", surname: "Chen" }, email_address: "maya@x.example", business_name: "Northwind" });
  assert.deepEqual(b.items[0], { name: "Logo concept", quantity: "2", unit_amount: { currency_code: "USD", value: "600.00" }, unit_of_measure: "QUANTITY", tax: { name: "VAT", percent: "7.5" } });
  assert.equal(totalOf(b), 1290);
});

test("paypalClient: signs in once, generates a number, creates, sends", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && init.body.startsWith("{") ? JSON.parse(init.body) : init.body, auth: init.headers.authorization });
    const path = new URL(url).pathname;
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/oauth2/token") return json({ access_token: "tok", expires_in: 3600 });
    if (path === "/v2/invoicing/generate-next-invoice-number") return json({ invoice_number: "0007" });
    if (path === "/v2/invoicing/invoices" && init.method === "POST") return json({ id: "INV2-AAAA", status: "DRAFT", ...JSON.parse(init.body), amount: { currency_code: "USD", value: "1200.00" } }, 201);
    if (path.endsWith("/send")) return new Response(null, { status: 202 });
    if (path === "/v2/invoicing/invoices/INV2-AAAA") return json({ id: "INV2-AAAA", status: "SENT", detail: { currency_code: "USD", invoice_number: "0007", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#X" } }, amount: { value: "1200.00" }, due_amount: { value: "1200.00" }, items: [] });
    return json({ message: "nope" }, 404);
  };
  const pp = paypalClient({ clientId: "id", clientSecret: "secret", fetchImpl });
  const inv = await pp.createInvoice({ customer_name: "Maya", currency: "USD", items: [{ name: "Logo", quantity: 2, unit_price: 600 }] });
  assert.equal(inv.id, "INV2-AAAA");
  const sent = summarize(await pp.sendInvoice("INV2-AAAA", { note: "Hi" }));
  assert.equal(sent.status, "SENT");
  assert.equal(sent.pay_link, "https://www.sandbox.paypal.com/invoice/p/#X");
  assert.equal(calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length, 1, "token is cached");
  assert.ok(calls[0].url.startsWith("https://api-m.sandbox.paypal.com"), "sandbox by default");
  assert.equal(calls[0].auth, `Basic ${Buffer.from("id:secret").toString("base64")}`);
  assert.equal(calls[2].body.detail.invoice_number, "0007");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/send")).body, { send_to_invoicer: true, send_to_recipient: true, note: "Hi" });
});

test("PayPal errors come back as one readable line", async () => {
  const fetchImpl = async (url) => new URL(url).pathname === "/v1/oauth2/token"
    ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
    : new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", details: [{ issue: "INVALID_CURRENCY", description: "Currency is not supported." }] }), { status: 422 });
  const pp = paypalClient({ clientId: "a", clientSecret: "b", fetchImpl });
  await assert.rejects(pp.getInvoice("INV2-X"), /could not be performed.*Currency is not supported/);
});

test("demo mode: create, send, pay", async () => {
  const pp = demoClient({ site: "http://x" });
  const inv = await pp.createInvoice({ customer_name: "Ana", currency: "USD", items: [{ name: "Work", quantity: 1, unit_price: 250 }] });
  assert.equal(inv.status, "DRAFT");
  assert.equal((await pp.sendInvoice(inv.id)).status, "SENT");
  const half = summarize(await pp.recordPayment(inv.id, { amount: 100 }));
  assert.equal(half.status, "PARTIALLY_PAID"); assert.equal(half.amount_due, 150); assert.equal(half.paid, 100);
  const paid = summarize(await pp.demoPay(inv.id));
  assert.equal(paid.status, "PAID"); assert.equal(paid.amount_due, 0);
  assert.equal(paid.pay_link, `http://x/demo/pay/${inv.id}`);
});
