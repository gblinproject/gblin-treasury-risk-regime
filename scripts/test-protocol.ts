/**
 * Protocol-level test: starts the built server over stdio and speaks MCP to it, the way a client does.
 *
 * Run:  npm run build && npx tsx scripts/test-protocol.ts
 *
 * Handler tests call functions directly and cannot see what a client sees: the result envelope, the
 * capabilities, the error codes. This one only talks JSON-RPC over the process pipes. It reads Base
 * mainnet (or GBLIN_RPC_URL) and sends no transaction.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = spawn("node", [join(here, "..", "dist", "index.js")], { stdio: ["pipe", "pipe", "pipe"], env: process.env });

let buffer = "";
const waiting = new Map<number, (msg: any) => void>();
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line.startsWith("{")) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});

let nextId = 1;
function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30_000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok      ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAILED  ${name} ${detail}`);
  }
}

async function main(): Promise<void> {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gblin.digital/selftest", version: "1" },
  });
  const caps = init.result?.capabilities ?? {};
  check("declares tools, prompts and resources", Boolean(caps.tools && caps.prompts && caps.resources), JSON.stringify(caps));
  check("sends instructions", typeof init.result?.instructions === "string" && init.result.instructions.length > 200);
  check("instructions do not claim the server signs", !/signer configured by the operator/i.test(init.result?.instructions ?? ""));

  // ── tools ────────────────────────────────────────────────────────────────
  const tools = (await rpc("tools/list")).result?.tools ?? [];
  check("lists twenty tools", tools.length === 20, String(tools.length));
  check("every tool carries a title", tools.every((t: any) => typeof t.annotations?.title === "string"));
  const state = await rpc("tools/call", { name: "get_treasury_state", arguments: {} });
  check("a tool result carries structuredContent", typeof state.result?.structuredContent === "object");
  const seed = await rpc("tools/call", {
    name: "share_skill_with_peer",
    arguments: { caller_wallet: "0x000000000000000000000000000000000000bEEF" },
  });
  const seedText: string = seed.result?.structuredContent?.text ?? "";
  check("the skill seed promises no fee to the referrer", seedText.length > 0 && !/redirect/i.test(seedText) && !/GBLIN_REFERRER/.test(seedText));
  check("the skill seed lists every tool", tools.every((t: any) => seedText.includes(`"${t.name}"`)));
  const retired = await rpc("tools/call", { name: "find_keeper_bounty", arguments: {} });
  check("a retired tool points to its replacement", /get_auction_state/.test(retired.result?.content?.[0]?.text ?? ""));

  // ── prompts ──────────────────────────────────────────────────────────────
  const prompts = (await rpc("prompts/list")).result?.prompts ?? [];
  check("lists four prompts", prompts.length === 4, String(prompts.length));
  for (const p of prompts) {
    const args: Record<string, string> = {};
    for (const a of p.arguments ?? []) if (a.required) args[a.name] = a.name === "input_hash" ? "a".repeat(64) : "0x000000000000000000000000000000000000bEEF";
    const got = await rpc("prompts/get", { name: p.name, arguments: args });
    const text = got.result?.messages?.[0]?.content?.text ?? "";
    check(`prompt ${p.name} returns a message`, text.length > 100, String(text.length));
  }
  const badPrompt = await rpc("prompts/get", { name: "does_not_exist", arguments: {} });
  check("an unknown prompt is an error", Boolean(badPrompt.error));

  // ── resources ────────────────────────────────────────────────────────────
  const resources = (await rpc("resources/list")).result?.resources ?? [];
  check("lists four resources", resources.length === 4, String(resources.length));
  for (const r of resources) {
    const got = await rpc("resources/read", { uri: r.uri });
    let parsed: any = null;
    try {
      parsed = JSON.parse(got.result?.contents?.[0]?.text ?? "");
    } catch {
      parsed = null;
    }
    check(`resource ${r.uri} is valid JSON`, parsed !== null && typeof parsed === "object");
    if (r.uri === "gblin://payments") {
      check("the payment domain is read from the token", typeof parsed?.eip712_domain?.name === "string" && parsed.eip712_domain.name.length > 0);
    }
  }
  const badResource = await rpc("resources/read", { uri: "gblin://does-not-exist" });
  check("an unknown resource is an error", Boolean(badResource.error));

  console.log(`\n=== ${passed} checks passed, ${failures.length} failed ===`);
  server.kill();
  if (failures.length) {
    console.log("failed:", failures.join(" · "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("error:", err);
  server.kill();
  process.exit(1);
});
