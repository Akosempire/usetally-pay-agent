// PayPal Invoicing API v2 client (sandbox by default).
// https://developer.paypal.com/docs/api/invoicing/v2/
//
// Without PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET it runs in demo mode: the
// same calls against an in-memory store, so the app can be tried with no
// PayPal account. Everything else in the app treats both the same way.

const SANDBOX = "https://api-m.sandbox.paypal.com";
const LIVE = "https://api-m.paypal.com";

export function money(value, currency) {
  return { currency_code: currency, value: (Math.round(Number(value) * 100) / 100).toFixed(2) };
}

// one PayPal invoice body from the agent's simple input
export function invoiceBody(input, { invoiceNumber, invoicer = {}, today = new Date() } = {}) {
  const currency = String(input.currency || "USD").toUpperCase();
  const [given, ...rest] = String(input.customer_name || "").trim().split(/\s+/);
  const due = input.due_date || addDays(today, Number(input.due_in_days ?? 14));
  const detail = {
    currency_code: currency,
    invoice_date: isoDate(today),
    payment_term: { due_date: due },
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
    ...(input.note ? { note: String(input.note).slice(0, 4000) } : {}),
    ...(input.terms ? { terms_and_conditions: String(input.terms).slice(0, 4000) } : {}),
    ...(input.reference ? { reference: String(input.reference).slice(0, 120) } : {}),
  };
  const recipient = {
    billing_info: {
      ...(given ? { name: { given_name: given, ...(rest.length ? { surname: rest.join(" ") } : {}) } } : {}),
      ...(input.customer_email ? { email_address: input.customer_email } : {}),
      ...(input.customer_company ? { business_name: input.customer_company } : {}),
    },
  };
  const items = (input.items || []).map((i) => ({
    name: String(i.name).slice(0, 200),
    ...(i.description ? { description: String(i.description).slice(0, 1000) } : {}),
    quantity: String(i.quantity ?? 1),
    unit_amount: money(i.unit_price, currency),
    unit_of_measure: "QUANTITY",
    ...(Number(input.tax_percent) > 0 ? { tax: { name: input.tax_name || "Tax", percent: String(input.tax_percent) } } : {}),
  }));
  return {
    detail,
    ...(invoicer.business_name || invoicer.email_address ? { invoicer } : {}),
    primary_recipients: [recipient],
    items,
    configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
  };
}

// what the agent and dashboard see: small, flat, numbers as numbers
export function summarize(inv) {
  const d = inv.detail || {};
  const r = inv.primary_recipients?.[0]?.billing_info || {};
  const name = [r.name?.given_name, r.name?.surname].filter(Boolean).join(" ");
  const total = Number(inv.amount?.value ?? totalOf(inv));
  const due = Number(inv.due_amount?.value ?? (["PAID", "MARKED_AS_PAID"].includes(inv.status) ? 0 : total));
  return {
    id: inv.id,
    number: d.invoice_number || null,
    status: inv.status,
    customer: r.business_name || name || r.email_address || "Customer",
    customer_email: r.email_address || null,
    currency: d.currency_code,
    total,
    amount_due: due,
    paid: Math.max(0, Math.round((total - due) * 100) / 100),
    invoice_date: d.invoice_date,
    due_date: d.payment_term?.due_date || null,
    pay_link: d.metadata?.recipient_view_url || inv.recipient_view_url || null,
    items: (inv.items || []).map((i) => ({ name: i.name, quantity: Number(i.quantity), unit_price: Number(i.unit_amount?.value) })),
  };
}

export function totalOf(inv) {
  let sum = 0;
  for (const i of inv.items || []) {
    const line = Number(i.quantity) * Number(i.unit_amount?.value || 0);
    sum += line + line * (Number(i.tax?.percent || 0) / 100);
  }
  return Math.round(sum * 100) / 100;
}

const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => isoDate(new Date(new Date(d).getTime() + n * 864e5));

// --------------------------------------------------------------- real PayPal

export function paypalClient({ clientId, clientSecret, live = false, fetchImpl = fetch, invoicer = {} } = {}) {
  const base = live ? LIVE : SANDBOX;
  let token = null, expires = 0;

  async function auth() {
    if (token && Date.now() < expires - 60_000) return token;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError("PayPal sign-in failed. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.", res.status);
    const j = await res.json();
    token = j.access_token; expires = Date.now() + Number(j.expires_in || 300) * 1000;
    return token;
  }

  async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await auth()}`, "content-type": "application/json", prefer: "return=representation" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw new PayPalError(paypalMessage(data) || `PayPal returned ${res.status}.`, res.status, data);
    return data;
  }

  const get = (id) => call("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);

  return {
    mode: live ? "live" : "sandbox",
    async createInvoice(input) {
      const { invoice_number } = await call("POST", "/v2/invoicing/generate-next-invoice-number");
      const created = await call("POST", "/v2/invoicing/invoices", invoiceBody(input, { invoiceNumber: invoice_number, invoicer }));
      // with return=representation PayPal answers with the invoice; older accounts answer with a link
      return created?.id ? created : get(created.href.split("/").pop());
    },
    async sendInvoice(id, { subject, note } = {}) {
      await call("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, { send_to_invoicer: true, send_to_recipient: true, ...(subject ? { subject } : {}), ...(note ? { note } : {}) });
      return get(id);
    },
    getInvoice: get,
    async listInvoices({ pageSize = 20 } = {}) {
      const j = await call("GET", `/v2/invoicing/invoices?page=1&page_size=${pageSize}&total_required=true`);
      return j?.items || [];
    },
    async remindInvoice(id, { subject, note } = {}) {
      await call("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, { send_to_invoicer: true, send_to_recipient: true, ...(subject ? { subject } : {}), ...(note ? { note } : {}) });
      return get(id);
    },
    async recordPayment(id, { amount, currency, method = "BANK_TRANSFER", date, note }) {
      await call("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
        method, payment_date: date || isoDate(new Date()), amount: money(amount, currency), ...(note ? { note } : {}),
      });
      return get(id);
    },
    async cancelInvoice(id, { note } = {}) {
      await call("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, { send_to_invoicer: true, send_to_recipient: true, ...(note ? { note } : {}) });
      return get(id);
    },
    // PayPal webhook check: https://developer.paypal.com/api/rest/webhooks/rest/
    async verifyWebhook(headers, event, webhookId) {
      const j = await call("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"], transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"], transmission_time: headers["paypal-transmission-time"], webhook_id: webhookId, webhook_event: event,
      });
      return j?.verification_status === "SUCCESS";
    },
  };
}

export class PayPalError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return { raw: t }; } };
function paypalMessage(d) {
  if (!d) return "";
  const issue = d.details?.[0];
  return [d.message, issue?.description || issue?.issue].filter(Boolean).join(": ").slice(0, 300);
}

// --------------------------------------------------------------- demo mode

export function demoClient({ today = new Date(), site = "" } = {}) {
  const store = new Map();
  let n = 1000;
  const make = (input, status = "DRAFT", paid = 0) => {
    const id = `INV2-DEMO-${String(++n)}`;
    const inv = invoiceBody(input, { invoiceNumber: String(n), today: input.invoice_date ? new Date(input.invoice_date) : today });
    inv.id = id; inv.status = status;
    const total = totalOf(inv);
    inv.amount = money(total, inv.detail.currency_code);
    inv.due_amount = money(total - paid, inv.detail.currency_code);
    inv.detail.metadata = { recipient_view_url: `${site}/demo/pay/${id}` };
    store.set(id, inv);
    return inv;
  };
  // a few examples so the dashboard isn't empty
  make({ customer_name: "Maya Chen", customer_company: "Northwind Studio", customer_email: "maya@northwind.example", currency: "USD", items: [{ name: "Brand identity design", quantity: 1, unit_price: 1800 }], due_date: addDays(today, -6), invoice_date: addDays(today, -20) }, "SENT");
  make({ customer_name: "Tom Okafor", customer_company: "Lagoon Events", customer_email: "tom@lagoon.example", currency: "USD", items: [{ name: "Event photography (half day)", quantity: 1, unit_price: 650 }, { name: "Edited photos", quantity: 40, unit_price: 5 }], due_date: addDays(today, 9), invoice_date: addDays(today, -5) }, "SENT");
  make({ customer_name: "Ana Lopez", customer_company: "Brightside Coffee", customer_email: "ana@brightside.example", currency: "USD", items: [{ name: "Website maintenance, October", quantity: 1, unit_price: 400 }], due_date: addDays(today, -12), invoice_date: addDays(today, -26) }, "PAID", 400);

  const need = (id) => { const inv = store.get(id); if (!inv) throw new PayPalError(`No invoice ${id}.`, 404); return inv; };
  const settle = (inv, amount) => {
    const due = Math.max(0, Number(inv.due_amount.value) - Number(amount));
    inv.due_amount = money(due, inv.detail.currency_code);
    inv.status = due === 0 ? "PAID" : "PARTIALLY_PAID";
  };
  return {
    mode: "demo",
    async createInvoice(input) { return structuredClone(make(input)); },
    async sendInvoice(id) { const inv = need(id); if (inv.status === "DRAFT") inv.status = "SENT"; return structuredClone(inv); },
    async getInvoice(id) { return structuredClone(need(id)); },
    async listInvoices() { return [...store.values()].reverse().map((i) => structuredClone(i)); },
    async remindInvoice(id) { const inv = need(id); if (!["SENT", "PARTIALLY_PAID"].includes(inv.status)) throw new PayPalError("Only sent, unpaid invoices can be reminded.", 422); inv.last_reminded = new Date().toISOString(); return structuredClone(inv); },
    async recordPayment(id, { amount }) { const inv = need(id); settle(inv, amount); return structuredClone(inv); },
    async cancelInvoice(id) { const inv = need(id); inv.status = "CANCELLED"; return structuredClone(inv); },
    // the demo "customer pays with PayPal" button
    async demoPay(id) { const inv = need(id); if (["SENT", "PARTIALLY_PAID"].includes(inv.status)) settle(inv, inv.due_amount.value); return structuredClone(inv); },
    async verifyWebhook() { return false; },
  };
}
