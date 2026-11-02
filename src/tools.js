// The agent's tools. One definition, used twice: by the MCP server (ChatGPT,
// Claude, Grok…) and by the built-in chat on the dashboard.
import * as z from "zod";
import { summarize } from "./paypal.js";

const id = z.string().min(3).max(64).describe("The PayPal invoice ID, like INV2-ABCD-1234-EFGH-5678 (from create_invoice or list_invoices).");
const item = z.object({
  name: z.string().min(1).max(200).describe("What was sold, e.g. 'Logo design'."),
  quantity: z.number().positive().max(100000).default(1),
  unit_price: z.number().nonnegative().max(10_000_000).describe("Price for one, in the invoice currency (150 = 150.00)."),
  description: z.string().max(1000).optional(),
});

const UNPAID = ["SENT", "PARTIALLY_PAID", "UNPAID", "SCHEDULED"];
const today = () => new Date().toISOString().slice(0, 10);
export const isOverdue = (s, on = today()) => UNPAID.includes(s.status) && s.due_date && s.due_date < on;

export const TOOLS = [
  {
    name: "create_invoice",
    title: "Create a PayPal invoice (draft)",
    description: "Creates a DRAFT PayPal invoice. Nothing is sent. Show the person the customer, items and total, and ask before calling send_invoice.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    input: {
      customer_name: z.string().min(1).max(140).describe("The customer's full name."),
      customer_email: z.string().email().optional().describe("Needed to email the invoice with send_invoice."),
      customer_company: z.string().max(140).optional(),
      currency: z.string().length(3).default("USD").describe("ISO currency PayPal supports, e.g. USD, GBP, EUR, CAD."),
      items: z.array(item).min(1).max(50),
      tax_percent: z.number().min(0).max(100).optional().describe("e.g. 7.5 for VAT at 7.5%."),
      tax_name: z.string().max(40).optional().describe("e.g. VAT, GST, Sales tax."),
      due_in_days: z.number().int().min(0).max(365).optional().describe("Default 14."),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; wins over due_in_days."),
      note: z.string().max(2000).optional().describe("A short note to the customer."),
    },
    async run(input, { paypal }) {
      return { invoice: summarize(await paypal.createInvoice(input)), next: "Show this to the person. Ask before sending." };
    },
  },
  {
    name: "send_invoice",
    title: "Send an invoice",
    description: "Emails the invoice to the customer from PayPal, with a link to pay by PayPal, card or Venmo. Only after the person confirms.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    input: { invoice_id: id, subject: z.string().max(200).optional(), note: z.string().max(2000).optional().describe("A short message in the email.") },
    async run({ invoice_id, subject, note }, { paypal }) {
      return { invoice: summarize(await paypal.sendInvoice(invoice_id, { subject, note })) };
    },
  },
  {
    name: "list_invoices",
    title: "List invoices",
    description: "Recent PayPal invoices, newest first. Filter: all, unpaid, overdue, paid or draft.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: { filter: z.enum(["all", "unpaid", "overdue", "paid", "draft"]).default("all"), limit: z.number().int().min(1).max(50).default(20) },
    async run({ filter = "all", limit = 20 }, { paypal }) {
      const all = (await paypal.listInvoices({ pageSize: 50 })).map(summarize);
      const keep = {
        all: () => true,
        unpaid: (s) => UNPAID.includes(s.status),
        overdue: (s) => isOverdue(s),
        paid: (s) => ["PAID", "MARKED_AS_PAID"].includes(s.status),
        draft: (s) => s.status === "DRAFT",
      }[filter];
      const list = all.filter(keep).slice(0, limit).map((s) => ({ ...s, overdue: isOverdue(s) }));
      return { count: list.length, invoices: list };
    },
  },
  {
    name: "get_invoice",
    title: "Look up an invoice",
    description: "One invoice: status, amounts, due date, items and the customer's pay link.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: { invoice_id: id },
    async run({ invoice_id }, { paypal }) {
      const s = summarize(await paypal.getInvoice(invoice_id));
      return { invoice: { ...s, overdue: isOverdue(s) } };
    },
  },
  {
    name: "remind_invoice",
    title: "Remind the customer",
    description: "Sends a payment reminder from PayPal for a sent, unpaid invoice. Write a short, polite note that fits how late it is. Ask the person first.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    input: { invoice_id: id, subject: z.string().max(200).optional(), note: z.string().max(2000).optional() },
    async run({ invoice_id, subject, note }, { paypal }) {
      return { invoice: summarize(await paypal.remindInvoice(invoice_id, { subject, note })), reminded: true };
    },
  },
  {
    name: "record_payment",
    title: "Record a payment made outside PayPal",
    description: "Marks money received another way (bank transfer, cash, cheque) against an invoice. Payments through PayPal are recorded automatically. Ask the person first.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    input: {
      invoice_id: id,
      amount: z.number().positive().max(10_000_000),
      method: z.enum(["BANK_TRANSFER", "CASH", "CHECK", "OTHER"]).default("BANK_TRANSFER"),
      note: z.string().max(500).optional(),
    },
    async run({ invoice_id, amount, method, note }, { paypal }) {
      const current = summarize(await paypal.getInvoice(invoice_id));
      if (amount > current.amount_due + 0.001) return { error: `That's more than the ${current.currency} ${current.amount_due.toFixed(2)} still due.` };
      return { invoice: summarize(await paypal.recordPayment(invoice_id, { amount, currency: current.currency, method, note })) };
    },
  },
  {
    name: "cancel_invoice",
    title: "Cancel an invoice",
    description: "Cancels a sent invoice; the customer's link shows it as cancelled. Can't be undone, so always ask first.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    input: { invoice_id: id, note: z.string().max(500).optional() },
    async run({ invoice_id, note }, { paypal }) {
      return { invoice: summarize(await paypal.cancelInvoice(invoice_id, { note })) };
    },
  },
  {
    name: "money_summary",
    title: "How much am I owed?",
    description: "Totals across recent invoices, per currency: still owed, overdue (with how many), and collected.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: {},
    async run(_, { paypal }) {
      const all = (await paypal.listInvoices({ pageSize: 50 })).map(summarize);
      return { totals: moneySummary(all) };
    },
  },
];

export function moneySummary(list) {
  const by = {};
  for (const s of list) {
    if (["DRAFT", "CANCELLED"].includes(s.status)) continue;
    const t = (by[s.currency] ||= { currency: s.currency, owed: 0, overdue: 0, overdue_count: 0, collected: 0 });
    t.owed += s.amount_due;
    t.collected += s.paid;
    if (isOverdue(s)) { t.overdue += s.amount_due; t.overdue_count++; }
  }
  return Object.values(by).map((t) => ({ ...t, owed: round(t.owed), overdue: round(t.overdue), collected: round(t.collected) }));
}
const round = (n) => Math.round(n * 100) / 100;

// runs a tool by name: checks the input, turns PayPal errors into one line
export async function runTool(name, input, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `Unknown tool ${name}.` };
  const parsed = z.object(tool.input).safeParse(input || {});
  if (!parsed.success) return { error: `Check the details: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}` };
  try {
    return await tool.run(parsed.data, ctx);
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 300) };
  }
}

// JSON Schema for model APIs (the built-in chat)
export const toolSchemas = () => TOOLS.map((t) => {
  const { $schema, ...schema } = z.toJSONSchema(z.object(t.input), { io: "input" });
  return { name: t.name, description: t.description, input_schema: schema };
});
