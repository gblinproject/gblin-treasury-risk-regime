/**
 * Hosted-server test: speaks MCP over Streamable HTTP with the official SDK client, which validates each
 * result against the tool's outputSchema, and calls every tool the hosted server imports from this package.
 *
 * Run against a local Worker:  cd worker && npx wrangler dev --port 8787   then
 *   npx tsx scripts/test-hosted.ts http://127.0.0.1:8787/mcp
 * Run against production:
 *   npx tsx scripts/test-hosted.ts https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp
 *
 * Reads only. payments.relay moves funds and receipts.seal writes to a public log: neither is called.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.argv[2] ?? "http://127.0.0.1:8787/mcp";
const HOLDER = "0x30590c0D05c26562d7296CE3D927d3418d2e6dcA";
const OTHER = "0x000000000000000000000000000000000000bEEF";

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
  const client = new Client({ name: "gblin.digital/selftest", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check("lists the imported tools", ["treasury.state", "actions.prepare", "actions.preview", "payments.relay", "treasury.nav_history"].every((n) => names.includes(n)), names.join(","));
  check("every imported tool carries an output schema", tools.filter((t) => /^(treasury|actions|payments|governance|auction|attestation)\./.test(t.name)).every((t) => t.outputSchema));

  const sample = await (await fetch("https://gblin.digital/api/x402/attestation-sample")).json();
  const run = async (name: string, args: Record<string, unknown>) => {
    try {
      const res = await client.callTool({ name, arguments: args });
      check(`${name}`, !res.isError && typeof res.structuredContent === "object", JSON.stringify(res.content).slice(0, 200));
      return res.structuredContent as Record<string, any>;
    } catch (err) {
      check(`${name}`, false, (err as Error).message.slice(0, 300));
      return null;
    }
  };

  await run("treasury.state", {});
  await run("treasury.quote", { direction: "buy", amount_in: "0.01" });
  await run("treasury.health", { wallet_address: HOLDER, daily_burn_usd: 1 });
  await run("treasury.nav_history", { interval: "hour", points: 6 });
  await run("governance.state", {});
  await run("auction.state", {});
  const prepared = await run("actions.prepare", { action: "exit_to_eth", wallet_address: HOLDER, amount: "0.001" });
  if (prepared) {
    const preview = await run("actions.preview", { from: HOLDER, steps: prepared.steps });
    check("the preview of a prepared exit would succeed", preview?.would_succeed === true, JSON.stringify(preview).slice(0, 300));
  }
  await run("actions.status", { hash: "0x366dc55dfe1fc3a1eb662a245ed7f5e6b54c68a0621124eafe5cf14188a2503c" });
  await run("payments.prepare", { from: HOLDER, to: OTHER, amount_gblin: "0.001" });
  await run("payments.verify", {
    authorization: { from: HOLDER, to: OTHER, value: "1", validAfter: "0", validBefore: "99999999999", nonce: "0x" + "aa".repeat(32) },
    signature: "0x" + "bb".repeat(65),
  });
  await run("attestation.verify", { attestation: sample });
  await run("risk.regime", {});

  // The npm names work here too, since the tools' descriptions refer to each other by them.
  const alias = await client.callTool({ name: "get_treasury_state", arguments: {} }).catch((e) => ({ isError: true, content: String(e) }));
  check("an npm tool name is accepted as an alias", !alias.isError, JSON.stringify(alias).slice(0, 200));

  await client.close();
  console.log(`\n=== ${passed} checks passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log("failed:", failures.join(" · "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("error:", err);
  process.exit(1);
});
