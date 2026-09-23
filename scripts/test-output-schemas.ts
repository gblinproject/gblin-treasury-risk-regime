/**
 * Output-schema test: calls every tool through the official MCP SDK client, which validates the
 * structuredContent of each successful result against the tool's declared outputSchema and throws
 * on a mismatch.
 *
 * Run:  npm run build && npx tsx scripts/test-output-schemas.ts
 *
 * Reads Base mainnet (or GBLIN_RPC_URL) and the free endpoints; sends no transaction. The one tool
 * that writes, seal_action_demo, is not called: it would append a permanent entry to a public log.
 *
 * Several tools return different fields on different paths (buy against sell, a wallet with and
 * without a balance), so each is called on every path. A negative control then feeds the same
 * validator a result with a required field removed, to prove the check can fail.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const here = dirname(fileURLToPath(import.meta.url));
const HOLDER = "0x30590c0D05c26562d7296CE3D927d3418d2e6dcA";
const OTHER = "0x000000000000000000000000000000000000bEEF";
const EMPTY = "0x0000000000000000000000000000000000000001";
const SAMPLE_URL = "https://gblin.digital/api/x402/attestation-sample";

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
  const sample = await (await fetch(SAMPLE_URL)).json();

  const calls: [string, Record<string, unknown>][] = [
    ["get_treasury_state", {}],
    ["quote_safe_swap", { direction: "buy", amount_in: "0.01" }],
    ["quote_safe_swap", { direction: "sell", amount_in: "0.01" }],
    ["swap_gblin_to_usdc_jit", { usdc_needed: "1", wallet_address: HOLDER }],
    ["invest_usdc_to_gblin", { usdc_amount: "10", wallet_address: HOLDER }],
    ["invest_usdc_to_gblin", { usdc_amount: "3", wallet_address: EMPTY }],
    ["analyze_treasury_health", { wallet_address: HOLDER }],
    ["analyze_treasury_health", { wallet_address: HOLDER, daily_burn_usd: 5 }],
    ["analyze_treasury_health", { wallet_address: EMPTY }],
    ["get_governance_state", {}],
    ["share_skill_with_peer", { caller_wallet: HOLDER }],
    ["get_auction_state", {}],
    ["get_market_risk_regime", {}],
    ["verify_risk_attestation", { attestation: sample }],
    ["get_receipt", { index: 20 }],
    ["get_receipt", { index: 5 }],
    ["how_to_seal_paid", {}],
    ["prepare_gblin_payment", { from: HOLDER, to: OTHER, amount_gblin: "0.001" }],
    ["prepare_gblin_payment", { from: HOLDER, to: OTHER, amount_usd: "1", method: "transfer" }],
    ["prepare_action", { action: "mint_with_eth", wallet_address: HOLDER, amount: "0.001" }],
    ["prepare_action", { action: "redeem_in_kind", wallet_address: HOLDER, amount: "0.001" }],
    ["prepare_action", { action: "exit_to_eth", wallet_address: HOLDER, amount: "0.001" }],
    ["prepare_action", { action: "mint_with_usdc", wallet_address: HOLDER, amount: "1" }],
    [
      "preview_steps",
      {
        from: HOLDER,
        steps: [{ target: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", calldata: "0x70a08231000000000000000000000000" + HOLDER.slice(2) }],
      },
    ],
    ["get_transaction_status", { hash: "0x366dc55dfe1fc3a1eb662a245ed7f5e6b54c68a0621124eafe5cf14188a2503c" }],
    ["get_transaction_status", { hash: "0x" + "ab".repeat(32) }],
    ["get_nav_history", { interval: "hour", points: 4 }],
    [
      "verify_gblin_authorization",
      {
        authorization: { from: HOLDER, to: OTHER, value: "1", validAfter: "0", validBefore: "99999999999", nonce: "0x" + "aa".repeat(32) },
        signature: "0x" + "bb".repeat(65),
      },
    ],
  ];

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(here, "..", "dist", "index.js")],
    env: process.env as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "gblin.digital/selftest", version: "1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const withSchema = tools.filter((t) => t.outputSchema).map((t) => t.name);
  const without = tools.filter((t) => !t.outputSchema).map((t) => t.name);
  check("every tool but the log writer declares an output schema", without.length === 1 && without[0] === "seal_action_demo", without.join(","));

  const covered = new Set<string>();
  for (const [name, args] of calls) {
    try {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) {
        check(`${name} ${JSON.stringify(args).slice(0, 60)}`, false, `tool error: ${(res.content as any)?.[0]?.text?.slice(0, 160)}`);
        continue;
      }
      covered.add(name);
      check(`${name} ${JSON.stringify(args).slice(0, 60)}`, typeof res.structuredContent === "object");
    } catch (err) {
      check(`${name} ${JSON.stringify(args).slice(0, 60)}`, false, (err as Error).message.slice(0, 300));
    }
  }
  // relay_gblin_payment moves funds, so it is exercised on a fork (test:payments), not here.
  const NOT_CALLED_ON_MAINNET = new Set(["relay_gblin_payment"]);
  const untested = withSchema.filter((n) => !covered.has(n) && !NOT_CALLED_ON_MAINNET.has(n));
  check("every declared schema was exercised", untested.length === 0, untested.join(","));

  // Negative control: the validator must reject a result missing a required field.
  const validator = new AjvJsonSchemaValidator();
  const treasury = tools.find((t) => t.name === "get_treasury_state")!;
  const good = await client.callTool({ name: "get_treasury_state", arguments: {} });
  const broken = { ...(good.structuredContent as Record<string, unknown>) };
  delete broken.nav_usd;
  const validate = validator.getValidator(treasury.outputSchema as any);
  check("the validator accepts a real result", validate(good.structuredContent).valid === true);
  check("the validator rejects a result without a required field", validate(broken).valid === false);

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
