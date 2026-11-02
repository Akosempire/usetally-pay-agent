# Usetally Pay Agent

**Invoice by chatting. Get paid with PayPal.**

An open-source AI agent for freelancers and small businesses. Tell it what you sold, in plain words, from ChatGPT, Claude, Grok or its own dashboard. It creates the PayPal invoice, sends it when you say so, reminds late payers in a tone that fits how late they are, records payments made outside PayPal, and tells you who owes what.

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/) by [Usetally](https://usetally.cc), invoicing for small businesses in Nigeria and beyond.

> "Invoice Northwind Studio for 2 logo concepts at $600 each, due in 10 days."
> → A PayPal invoice for $1,200, shown to you first. "Yes, send it." → Maya gets an email from PayPal and pays by PayPal, card or Venmo.

## Why

Many freelancers in Africa and elsewhere work for clients abroad and get paid through PayPal. Making an invoice, remembering who hasn't paid, and writing the awkward "just following up" email takes time they don't have. This agent does that work from the chat they already use, on PayPal's own invoicing, so the money goes straight to their PayPal account.

## What it does

| You say | The agent | PayPal API |
|---|---|---|
| "Invoice Tom at Lagoon Events for half-day photography, $650, plus 40 edits at $5" | Drafts the invoice, shows you the total | `generate-next-invoice-number`, `POST /v2/invoicing/invoices` |
| "Yes, send it" | Emails it from PayPal with a pay link | `POST /invoices/{id}/send` |
| "Who owes me money?" | Totals still owed, overdue and collected | `GET /v2/invoicing/invoices` |
| "Remind everyone who's overdue" | Writes a short note for each, asks, then sends | `POST /invoices/{id}/remind` |
| "Ana paid $400 by bank transfer" | Records it against the right invoice | `POST /invoices/{id}/payments` |
| "Cancel invoice 1004" | Asks first, then cancels | `POST /invoices/{id}/cancel` |
| (the customer pays) | Shows up on the dashboard | Webhook `INVOICING.INVOICE.PAID`, verified with `verify-webhook-signature` |

It never sends, reminds, records or cancels without asking: every tool tells the model so, and the tools are marked read-only or not, so MCP clients that ask before actions can do that too.

## How the AI part works

- **One set of tools, two ways in** ([`src/tools.js`](src/tools.js)): eight tools with Zod schemas.
  - **MCP server** ([`src/mcp.js`](src/mcp.js)), over Streamable HTTP at `/mcp` or stdio. ChatGPT, Claude, Grok, Cursor and any MCP client can use it.
  - **Built-in chat** ([`src/agent.js`](src/agent.js)): Claude (Anthropic Messages API, tool use) on the dashboard, so it works without setting up a connector.
- The model works out the customer, items, quantities, tax and due date from a sentence. It writes reminder notes that get firmer the later an invoice is, and picks the right invoice when you say "it" or "Tom's".
- The dashboard ([`public/index.html`](public/index.html)) shows invoices, totals and an activity feed, live. Invoices made from ChatGPT appear there within seconds.

## Run it

Needs Node.js 20 or newer.

```bash
git clone https://github.com/Akosempire/usetally-pay-agent && cd usetally-pay-agent
npm install
cp .env.example .env   # optional: add PayPal sandbox keys and an Anthropic key
npm start              # http://localhost:3000
```

- **No keys:** it runs in **demo mode**, with the same tools on an in-memory store and three sample invoices. A demo customer page lets you "pay" an invoice and watch the dashboard update.
- **PayPal sandbox:**
  1. At [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox), create an app and copy its Client ID and Secret into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
  2. Invoices go to sandbox buyer accounts. Pay them at the `pay_link` while signed in to a sandbox personal account.
  3. Optional: add a webhook to `https://<your-host>/webhooks/paypal` for `INVOICING.INVOICE.PAID` and put its ID in `PAYPAL_WEBHOOK_ID`.
- **Built-in chat:** set `ANTHROPIC_API_KEY`. `AGENT_MODEL` picks the Claude model.
- **Lock it:** set `ACCESS_KEY`. The dashboard asks for it once; MCP clients send `Authorization: Bearer <key>` or add `?key=<key>` to the URL.

Load these with `node --env-file=.env src/server.js`, or set them in your host. `render.yaml` deploys it on Render in one step.

### Connect an AI assistant

- **ChatGPT:** Settings → Apps → Advanced settings → Developer mode → Create app. Paste `https://<your-host>/mcp` (add `?key=…` if locked).
- **Claude:** Settings → Connectors → Add custom connector, then paste the same address.
- **Claude Desktop, Claude Code or Cursor (local):** add this server:

```json
{ "mcpServers": { "usetally-pay": { "command": "node", "args": ["/path/to/usetally-pay-agent/src/stdio.js"],
  "env": { "PAYPAL_CLIENT_ID": "…", "PAYPAL_CLIENT_SECRET": "…" } } } }
```

## Tests

```bash
npm test
```

The tests cover:
- the PayPal request shapes (mocked HTTP): token caching, invoice body, send, and error messages;
- every tool against demo mode;
- the Claude tool-use loop (scripted model);
- the MCP endpoint end to end (initialize, list and call over HTTP);
- the demo pay flow;
- webhook signature refusal.

## Project layout

```
src/paypal.js   PayPal Invoicing v2 client (sandbox/live) + demo mode
src/tools.js    the 8 agent tools (schemas, safety notes, PayPal calls)
src/mcp.js      MCP server (Streamable HTTP + stdio)
src/agent.js    built-in chat: Claude tool-use loop
src/server.js   dashboard, /api, /mcp, PayPal webhooks, demo pay page
public/         dashboard and demo customer page (no build step)
test/           node:test suites
```

## Safety

- **PayPal keys stay on the server.** Nothing PayPal-related reaches the browser except invoice summaries.
- **The browser can't change the agent's instructions.** It can only send its own chat turns; system prompts and malformed tool turns are dropped.
- **The built-in chat is rate-limited per visitor.**
- **Webhooks must pass PayPal's signature check** before they're used.

## Licence

MIT. See [LICENSE](LICENSE).
