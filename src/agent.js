// The dashboard's built-in chat: Claude with the same tools the MCP server
// offers (Anthropic Messages API, tool use). Stateless: the browser sends the
// conversation back each turn, including earlier tool calls, so "yes, send
// it" knows which invoice "it" is.
import { INSTRUCTIONS } from "./mcp.js";
import { runTool, toolSchemas } from "./tools.js";

const MAX_STEPS = 6;
const MAX_MESSAGES = 40;

export function agentConfigured(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY);
}

// a key the person pasted in Settings (kept in their browser, sent per request, never stored)
export const looksLikeKey = (k) => /^sk-ant-[A-Za-z0-9_\-]{20,200}$/.test(String(k || ""));
export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];

export async function chat(messages, { paypal, env = process.env, fetchImpl = fetch, onEvent, apiKey, model } = {}) {
  const key = looksLikeKey(apiKey) ? apiKey : env.ANTHROPIC_API_KEY;
  if (!key) return { error: "Add your Anthropic API key in Settings to chat here. You can also use the agent from ChatGPT, Claude or any MCP client." };
  const useModel = MODELS.includes(model) ? model : env.AGENT_MODEL || "claude-sonnet-5-5";
  const history = clean(messages).slice(-MAX_MESSAGES);
  const events = [];
  const system = `${INSTRUCTIONS}
- You are chatting inside the agent's own dashboard. Keep replies short (2-4 sentences), plain words, amounts with currency.
- Today is ${new Date().toISOString().slice(0, 10)}.`;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: useModel, max_tokens: 1024, system, tools: toolSchemas(), messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return { error: "Anthropic didn't accept that API key. Check it in Settings.", messages: history, events, keyRejected: true };
    if (!res.ok) return { error: data?.error?.message || `The AI service returned ${res.status}.`, messages: history, events };
    history.push({ role: "assistant", content: data.content });
    const calls = (data.content || []).filter((b) => b.type === "tool_use");
    if (!calls.length || data.stop_reason !== "tool_use") {
      const reply = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { reply, messages: history, events };
    }
    const results = [];
    for (const c of calls) {
      const out = await runTool(c.name, c.input, { paypal });
      const ev = { source: "chat", tool: c.name, ok: !out.error, invoice: out.invoice || null };
      events.push(ev); onEvent?.(ev);
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
    }
    history.push({ role: "user", content: results });
  }
  return { reply: "That took more steps than expected. Try asking in smaller pieces.", messages: history, events };
}

// only well-formed turns from the browser, and never a system prompt
function clean(messages) {
  const ok = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!["user", "assistant"].includes(m?.role)) continue;
    if (typeof m.content === "string") { if (m.content.trim()) ok.push({ role: m.role, content: m.content.slice(0, 4000) }); continue; }
    if (Array.isArray(m.content)) ok.push({ role: m.role, content: m.content.filter((b) => ["text", "tool_use", "tool_result"].includes(b?.type)) });
  }
  // the conversation must start with the person
  while (ok.length && (ok[0].role !== "user" || Array.isArray(ok[0].content) && ok[0].content.some((b) => b.type === "tool_result"))) ok.shift();
  return ok;
}

// Settings → "Test key": a tiny request that costs almost nothing
export async function checkKey(apiKey, { fetchImpl = fetch, model } = {}) {
  if (!looksLikeKey(apiKey)) return { ok: false, error: "That doesn't look like an Anthropic key. It starts with sk-ant-." };
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELS.includes(model) ? model : MODELS[0], max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
  }).catch(() => null);
  if (!res) return { ok: false, error: "Couldn't reach Anthropic. Try again." };
  if (res.status === 401 || res.status === 403) return { ok: false, error: "Anthropic didn't accept that key." };
  if (res.status === 404) return { ok: false, error: "The key works, but that model isn't available on it. Pick another model." };
  if (!res.ok) { const d = await res.json().catch(() => ({})); return { ok: false, error: d?.error?.message || `Anthropic returned ${res.status}.` }; }
  return { ok: true };
}
