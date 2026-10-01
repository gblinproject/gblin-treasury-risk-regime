/**
 * `search` and `fetch`: the two read-only tools research clients expect (OpenAI's deep research and
 * company-knowledge connectors, and any client that wants documents rather than functions).
 *
 * `search(query)` returns `{ results: [{ id, title, url }] }` over a small, curated corpus: the agent
 * API summary, the protocol's README and documents, the server READMEs, the public pages, one card
 * per MCP tool, and a snapshot of the live state. `fetch(id)` returns the full text of one document
 * as `{ id, title, text, url, metadata }`. Both results travel as structuredContent and as a JSON
 * string in the content array, the shape those clients read.
 *
 * Documents are fetched on demand through the caller's cached fetch and never stored elsewhere.
 */

const SITE = "https://gblin.digital";
const RAW = "https://raw.githubusercontent.com/gblinproject";
const MAX_TEXT_CHARS = 60_000;
const MAX_RESULTS = 10;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Static documents: id -> where the text comes from. Order is the tie-break in search. */
const DOCUMENTS = [
  { id: "agent-api", title: "GBLIN agent API summary (llms.txt)", url: `${SITE}/api/x402/llms.txt`, kind: "text", ttl: 3600 },
  { id: "protocol-readme", title: "GBLIN Protocol: overview and contracts", url: "https://github.com/gblinproject/GBLIN-Protocol", src: `${RAW}/GBLIN-Protocol/main/README.md`, kind: "text", ttl: 3600 },
  { id: "protocol-governance", title: "GBLIN Protocol: governance and the timelock", url: "https://github.com/gblinproject/GBLIN-Protocol/blob/main/docs/governance.md", src: `${RAW}/GBLIN-Protocol/main/docs/governance.md`, kind: "text", ttl: 3600 },
  { id: "protocol-deployments", title: "GBLIN Protocol: deployments on Base", url: "https://github.com/gblinproject/GBLIN-Protocol/blob/main/docs/deployments.md", src: `${RAW}/GBLIN-Protocol/main/docs/deployments.md`, kind: "text", ttl: 3600 },
  { id: "protocol-audits", title: "GBLIN Protocol: review and testing record", url: "https://github.com/gblinproject/GBLIN-Protocol/blob/main/audits/README.md", src: `${RAW}/GBLIN-Protocol/main/audits/README.md`, kind: "text", ttl: 3600 },
  { id: "mcp-readme", title: "GBLIN MCP server: tools, prompts and resources", url: "https://github.com/gblinproject/gblin-treasury-risk-regime", src: `${RAW}/gblin-treasury-risk-regime/main/README.md`, kind: "text", ttl: 3600 },
  { id: "agent-treasury-readme", title: "Agent treasury library: USDC reserve, surplus in GBLIN", url: "https://www.npmjs.com/package/@gblin-protocol/agent-treasury", src: `${RAW}/gblin-treasury-risk-regime/main/packages/agent-treasury/README.md`, kind: "text", ttl: 3600 },
  { id: "eliza-plugin-readme", title: "GBLIN plugin for ElizaOS agents", url: "https://www.npmjs.com/package/plugin-gblin", src: `${RAW}/GBLIN_PLUGIN/main/README.md`, kind: "text", ttl: 3600 },
  { id: "page-agents", title: "GBLIN for AI agents: risk regime, treasury tools, MCP", url: `${SITE}/agents`, kind: "html", ttl: 3600 },
  { id: "page-treasury", title: "Treasury plan: idle USDC, operating cash and a GBLIN simulation", url: `${SITE}/treasury`, kind: "html", ttl: 3600 },
  { id: "page-coherence", title: "Coherence proof: promises observed and sealed on Base", url: `${SITE}/coherence`, kind: "html", ttl: 3600 },
  { id: "page-faq", title: "GBLIN frequently asked questions", url: `${SITE}/faq`, kind: "html", ttl: 3600 },
];

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "what", "how", "does", "can", "you", "your", "our", "its", "into", "not", "any", "all", "has", "have", "was", "were", "will", "about", "over", "than", "then", "when", "where", "which", "who", "why", "gblin"]);

function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []).filter((t) => t.length > 2 && !STOP.has(t));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** One card per MCP tool: name, description, input and output shape. */
function toolDocuments(tools) {
  return tools.map((t) => ({
    id: `tool-${t.name}`,
    title: `MCP tool ${t.name}: ${(t.annotations && t.annotations.title) || t.name}`,
    url: "https://gblin-mcp.gblin-mcp-worker.workers.dev/tools.json",
    kind: "tool",
    text: [
      `Tool: ${t.name}`,
      t.annotations && t.annotations.title ? `Title: ${t.annotations.title}` : "",
      `Description: ${t.description}`,
      `Input: ${JSON.stringify(t.inputSchema)}`,
      t.outputSchema ? `Output: ${JSON.stringify(t.outputSchema)}` : "",
      "Free, no authentication. Hosted at https://mcp.gblin.digital/mcp (Streamable HTTP); the same tools run locally with npx @gblin-protocol/mcp-server.",
    ].filter(Boolean).join("\n"),
  }));
}

async function liveStateDocument(cachedFetch) {
  const [state, regime] = await Promise.all([
    cachedFetch(`${SITE}/api/x402/treasury-state`, 60).then((r) => r.json()).catch(() => null),
    cachedFetch(`${SITE}/api/x402/governance`, 600).then((r) => r.json()).catch(() => null),
  ]);
  return {
    id: "live-state",
    title: "GBLIN live state: NAV, basket weights, crash shield, governance",
    url: `${SITE}/api/x402/treasury-state`,
    kind: "live",
    text: [
      "Live values read from Base at the time of the request; they change with the market.",
      state ? `Treasury state:\n${JSON.stringify(state, null, 2)}` : "Treasury state: unavailable",
      regime ? `Governance:\n${JSON.stringify(regime, null, 2)}` : "",
    ].filter(Boolean).join("\n\n"),
  };
}

async function loadText(doc, cachedFetch) {
  if (doc.text !== undefined) return doc.text;
  const res = await cachedFetch(doc.src || doc.url, doc.ttl || 3600);
  if (!res.ok) throw new Error(`document unavailable (${res.status})`);
  const raw = await res.text();
  return doc.kind === "html" ? stripHtml(raw) : raw;
}

/** The whole corpus with texts loaded; tool cards and the live snapshot need no fetch of their own. */
async function corpus(tools, cachedFetch) {
  const live = await liveStateDocument(cachedFetch);
  const docs = [...DOCUMENTS, ...toolDocuments(tools), live];
  const loaded = await Promise.all(
    docs.map(async (d) => {
      try {
        return { ...d, text: await loadText(d, cachedFetch) };
      } catch {
        return null;
      }
    })
  );
  return loaded.filter(Boolean);
}

export const SEARCH_TOOL = {
  name: "search",
  description:
    "Search GBLIN's documentation and live state and return matching documents: the agent API summary, the protocol's README and documents (governance, deployments, review record), the MCP server and library READMEs, the public pages, one card per MCP tool, and a snapshot of the live vault state. Returns {results: [{id, title, url}]}; pass an id to fetch for the full text. Read-only and free.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "What to look for, in plain words." } },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { title: "Search GBLIN documentation", ...READ_ONLY },
  outputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" } },
          required: ["id", "title", "url"],
        },
      },
    },
    required: ["results"],
  },
};

export const FETCH_TOOL = {
  name: "fetch",
  description:
    "Return the full text of one document found with search: {id, title, text, url, metadata}. Documents are the protocol's public documentation, the tool cards and the live vault state. Read-only and free.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "A document id returned by search." } },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { title: "Fetch a GBLIN document", ...READ_ONLY },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      text: { type: "string" },
      url: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["id", "title", "text", "url"],
  },
};

export async function searchDocuments(query, tools, cachedFetch) {
  const q = tokens(String(query || ""));
  if (q.length === 0) throw Object.assign(new Error("query must contain at least one word of three letters or more"), { code: -32602 });
  const docs = await corpus(tools, cachedFetch);
  const scored = docs
    .map((d) => {
      const title = d.title.toLowerCase();
      const text = d.text.toLowerCase();
      let score = 0;
      for (const t of q) {
        if (title.includes(t)) score += 5;
        const hits = text.split(t).length - 1;
        score += Math.min(hits, 20);
      }
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
  return { results: scored.map(({ d }) => ({ id: d.id, title: d.title, url: d.url })) };
}

export async function fetchDocument(id, tools, cachedFetch) {
  const key = String(id || "");
  const known = DOCUMENTS.find((d) => d.id === key) || toolDocuments(tools).find((d) => d.id === key) || (key === "live-state" ? await liveStateDocument(cachedFetch) : null);
  if (!known) throw Object.assign(new Error(`unknown document id: ${key}. Use search to list the ids.`), { code: -32602 });
  const text = await loadText(known, cachedFetch);
  return {
    id: known.id,
    title: known.title,
    text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + "\n[truncated]" : text,
    url: known.url,
    metadata: { kind: known.kind, chars: text.length, fetched_at: new Date().toISOString() },
  };
}
