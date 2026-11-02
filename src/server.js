#!/usr/bin/env node
// Usetally Pay Agent: dashboard, built-in chat, MCP endpoint and PayPal webhooks.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { paypalFromEnv } from "./config.js";
import { agentConfigured, chat } from "./agent.js";
import { moneySummary, isOverdue } from "./tools.js";
import { summarize } from "./paypal.js";

const PORT = Number(process.env.PORT || 3000);
const SITE = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const KEY = process.env.ACCESS_KEY || "";
const paypal = paypalFromEnv(process.env, { site: SITE });
const page = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

// what happened lately (tool calls from any AI, PayPal webhooks), for the dashboard feed
const activity = [];
function log(ev) {
  activity.unshift({ at: new Date().toISOString(), ...ev });
  activity.length = Math.min(activity.length, 50);
}

// a small per-IP limit on the built-in chat, so a public demo can't run up the AI bill
const hits = new Map();
function limited(ip, max = 40) {
  const now = Date.now(), hour = 3600_000;
  const list = (hits.get(ip) || []).filter((t) => now - t < hour);
  list.push(now); hits.set(ip, list);
  return list.length > max;
}

function allowed(req, url) {
  if (!KEY) return true;
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("key") || req.headers["x-access-key"] || "";
  const a = Buffer.from(String(given)), b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("too_large"); chunks.push(c); }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
const send = (res, status, data, headers = {}) => {
  const isText = typeof data === "string";
  res.writeHead(status, { "content-type": isText ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store", ...headers });
  res.end(isText ? data : JSON.stringify(data));
};
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-expose-headers": "mcp-session-id" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, SITE);
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  try {
    if (req.method === "OPTIONS") return send(res, 204, "", CORS);

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, await page("index.html"));
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, mode: paypal.mode });

    // ---- MCP (ChatGPT, Claude, Grok, Cursor…)
    if (url.pathname === "/mcp") {
      if (!allowed(req, url)) return send(res, 401, { error: "Add your access key: Authorization: Bearer <ACCESS_KEY>, or ?key=" }, CORS);
      if (req.method !== "POST") return send(res, 405, { error: "Use POST." }, { allow: "POST", ...CORS });
      const mcp = createMcpServer({ paypal, onEvent: log });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
      res.on("close", () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      return transport.handleRequest(req, res, await body(req));
    }

    // ---- dashboard data
    if (req.method === "GET" && url.pathname === "/api/state") {
      if (!allowed(req, url)) return send(res, 401, { error: "locked" });
      const invoices = (await paypal.listInvoices({ pageSize: 50 })).map(summarize).map((s) => ({ ...s, overdue: isOverdue(s) }));
      return send(res, 200, { mode: paypal.mode, business: process.env.BUSINESS_NAME || "", agent: agentConfigured(), mcp_url: `${SITE}/mcp`, locked: Boolean(KEY), invoices, totals: moneySummary(invoices), activity });
    }

    // ---- built-in chat
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!allowed(req, url)) return send(res, 401, { error: "locked" });
      if (limited(ip)) return send(res, 429, { error: "That's a lot of messages. Try again in a while." });
      const { messages } = await body(req);
      return send(res, 200, await chat(messages, { paypal, onEvent: log }));
    }

    // ---- PayPal webhooks: a customer paid (or the invoice changed)
    if (req.method === "POST" && url.pathname === "/webhooks/paypal") {
      const event = await body(req);
      const hook = process.env.PAYPAL_WEBHOOK_ID;
      if (!hook || !(await paypal.verifyWebhook(req.headers, event, hook).catch(() => false))) return send(res, 400, { error: "not verified" });
      const inv = event.resource?.invoice || event.resource;
      log({ source: "paypal", tool: event.event_type, ok: true, invoice: inv?.id ? summarize(inv) : null });
      return send(res, 200, { ok: true });
    }

    // ---- demo mode: the customer's pay page
    const pay = url.pathname.match(/^\/demo\/pay\/([\w-]+)$/);
    if (pay && paypal.mode === "demo") {
      if (req.method === "POST") {
        const inv = summarize(await paypal.demoPay(pay[1]));
        log({ source: "paypal", tool: "INVOICING.INVOICE.PAID", ok: true, invoice: inv });
        return send(res, 200, { invoice: inv });
      }
      const inv = summarize(await paypal.getInvoice(pay[1]));
      return send(res, 200, (await page("pay.html")).replace("__INVOICE__", JSON.stringify(inv).replace(/</g, "\\u003c")));
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (e?.message === "too_large") return send(res, 413, { error: "Too large" });
    if (e instanceof SyntaxError) return send(res, 400, { error: "Send JSON." });
    console.error(e);
    if (!res.headersSent) send(res, e?.status === 404 ? 404 : 500, { error: e?.status === 404 ? "Not found" : "Something went wrong." });
  }
});

server.listen(PORT, () => console.log(`Usetally Pay Agent on ${SITE} (PayPal: ${paypal.mode}${agentConfigured() ? ", chat on" : ", chat off: set ANTHROPIC_API_KEY"})`));
