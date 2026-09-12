/**
 * Live smoke test against Base mainnet (read-only).
 *
 * Run: npm test
 *
 * Exercises every tool with conservative inputs. The MCP server itself is
 * not started — we call the handlers directly to validate logic + RPC.
 * No transactions are broadcast.
 */

import {
  handleAnalyzeTreasury,
  handleGetGovernanceState,
  handleGetTreasuryState,
  handleInvest,
  handleJitSwap,
  handleQuoteSafeSwap,
} from "../src/tools.js";
import { bountyDue, effectiveBps, rewardGate, volumeBoostBps, type BountyRules } from "../src/keeper.js";

// Pure keeper math, checked against GBLIN_V6 `_bounty` / `_volumeBoost` with the
// contract's real values at Base block 51224419 (12 Sep 2026).
const RULES: BountyRules = {
  incentiveBps: 5n,
  minBounty: 50000000000000n,             // 0.00005 ETH
  maxBounty: 10000000000000000n,          // 0.01 ETH
  bountyInterval: 3600n,
  lastBountyTime: 1787271593n,
  volumeRefEth: 10000000000000000000n,    // 10 ETH
  lastWindowVolume: 580915286567522n,     // 0.00058 ETH
  stabilityFund: 69045636546080n,         // 0.000069 ETH
};
function expect(name: string, got: unknown, want: unknown): void {
  if (String(got) !== String(want)) throw new Error(`${name}: got ${String(got)}, want ${String(want)}`);
}
function keeperMath(): { content: { text: string }[] } {
  const now = 1789238981n; // well past lastBountyTime + interval
  expect("boost at 0.00058/10 ETH volume", volumeBoostBps(RULES), 0n);
  expect("effective bps", effectiveBps(RULES), 5n);
  expect("0.01 ETH rebalance -> floor", bountyDue(10000000000000000n, RULES), 50000000000000n);
  expect("gate open (fund 0.000069 >= floor 0.00005)", rewardGate(now, 50000000000000n, RULES), "open");
  expect("gate closed inside the hour", rewardGate(RULES.lastBountyTime + 3599n, 50000000000000n, RULES), "interval-active");
  expect("gate closed when fund < due", rewardGate(now, 50000000000000n, { ...RULES, stabilityFund: 40000000000000n }), "fund-insufficient");
  const full = { ...RULES, lastWindowVolume: RULES.volumeRefEth };
  expect("full volume window doubles bps", effectiveBps(full), 10n);
  expect("10 ETH rebalance at full boost -> cap", bountyDue(10000000000000000000n, full), 10000000000000000n);
  expect("cap exceeds fund -> not paid", rewardGate(now, 10000000000000000n, full), "fund-insufficient");
  expect("half window -> 7 bps (integer)", effectiveBps({ ...RULES, lastWindowVolume: 5000000000000000000n }), 7n);
  expect("volumeRefEth 0 -> no boost", volumeBoostBps({ ...RULES, volumeRefEth: 0n }), 0n);
  return { content: [{ text: "11 assertions on the V6 bounty formula and gates" }] };
}

// A well-known Base wallet for read-only balance probes (Coinbase hot wallet).
// Replace if you want to test against your own wallet.
const TEST_WALLET = "0x4200000000000000000000000000000000000006"; // WETH contract — always has balance

interface TestCase {
  name: string;
  run: () => Promise<unknown>;
}

const cases: TestCase[] = [
  {
    name: "keeper bounty math (pure, V6 rules at block 51224419)",
    run: async () => keeperMath(),
  },
  {
    name: "get_treasury_state",
    run: () => handleGetTreasuryState(),
  },
  {
    name: "quote_safe_swap (buy 0.001 ETH)",
    run: () => handleQuoteSafeSwap({ direction: "buy", amount_in: "0.001" }),
  },
  {
    name: "quote_safe_swap (sell 1.0 GBLIN)",
    run: () => handleQuoteSafeSwap({ direction: "sell", amount_in: "1.0" }),
  },
  {
    name: "swap_gblin_to_usdc_jit ($0.50)",
    run: () =>
      handleJitSwap({
        usdc_needed: "0.50",
        wallet_address: TEST_WALLET,
      }),
  },
  {
    name: "invest_usdc_to_gblin ($10)",
    run: () =>
      handleInvest({
        usdc_amount: "10",
        wallet_address: TEST_WALLET,
      }),
  },
  {
    name: "analyze_treasury_health (WETH contract)",
    run: () =>
      handleAnalyzeTreasury({
        wallet_address: TEST_WALLET,
        daily_burn_usd: 1.0,
      }),
  },
  {
    name: "get_governance_state",
    run: () => handleGetGovernanceState({}),
  },
];

function summarize(out: unknown): string {
  if (typeof out !== "object" || out === null) return String(out);
  const o = out as { isError?: boolean; content?: { text: string }[] };
  if (o.isError) return `⚠️  ERROR: ${o.content?.[0]?.text ?? "?"}`;
  const text = o.content?.[0]?.text ?? "";
  // Truncate long output for readability
  return text.length > 500 ? text.slice(0, 500) + "\n  ... [truncated]" : text;
}

async function main(): Promise<void> {
  console.log("─".repeat(70));
  console.log("GBLIN MCP — Live test against Base mainnet");
  console.log("─".repeat(70));

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const t0 = Date.now();
    try {
      const result = await tc.run();
      const dt = Date.now() - t0;
      const o = result as { isError?: boolean };
      if (o.isError) {
        failed++;
        console.log(`\n❌ ${tc.name}  (${dt}ms)`);
        console.log(summarize(result));
      } else {
        passed++;
        console.log(`\n✅ ${tc.name}  (${dt}ms)`);
        console.log(summarize(result));
      }
    } catch (err) {
      failed++;
      const dt = Date.now() - t0;
      console.log(`\n💥 ${tc.name}  (${dt}ms)`);
      console.log(`  Threw: ${(err as Error).message}`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(70));
  process.exit(failed > 0 ? 1 : 0);
}

main();
