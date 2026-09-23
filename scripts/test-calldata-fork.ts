/**
 * End-to-end test of the calldata tools against a fork of Base.
 *
 * Run:  anvil --fork-url <base rpc> --port 8555 --silent &
 *       GBLIN_RPC_URL=http://127.0.0.1:8555 npx tsx scripts/test-calldata-fork.ts
 *
 * A tool that returns calldata is only as good as the transactions it produces. This test sends the
 * exact steps the tools return, in order, from a real holder impersonated on the fork, and checks the
 * balances that result. The round trip exercises both tools against each other: the USDC produced by
 * the exit is what the second tool invests back into GBLIN.
 */

import { createTestClient, http, publicActions, walletActions, parseUnits, formatUnits, type Hex } from "viem";
import { base } from "viem/chains";

import { ERC20_ABI } from "../src/abi.js";
import { GBLIN_VAULT, USDC } from "../src/config.js";
import { handleInvest, handleJitSwap } from "../src/tools.js";

const RPC = process.env.GBLIN_RPC_URL ?? "http://127.0.0.1:8555";
/** A holder with shares and ETH on Base; impersonated only on the fork. */
const HOLDER = "0x30590c0D05c26562d7296CE3D927d3418d2e6dcA" as const;

const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) })
  .extend(publicActions)
  .extend(walletActions);

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

interface Step {
  step: number;
  description: string;
  target: `0x${string}`;
  calldata: Hex;
  value: string;
  gas?: string;
}

async function call(fn: (a: unknown) => Promise<unknown>, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = (await fn(args)) as { structuredContent?: Record<string, any>; content?: { text: string }[]; isError?: boolean };
  if (res.isError) throw new Error(`tool error: ${res.content?.[0]?.text ?? "unknown"}`);
  return res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? "{}");
}

/** Sends every step exactly as the tool returned it; stops at the first failure. */
async function run(steps: Step[], label: string): Promise<boolean> {
  for (const s of steps) {
    try {
      const hash = await test.sendTransaction({
        account: HOLDER,
        to: s.target,
        data: s.calldata,
        value: BigInt(s.value ?? "0"),
        // A wallet honours the gas the tool returns; without it the wallet estimates.
        ...(s.gas ? { gas: BigInt(s.gas) } : {}),
        chain: base,
      });
      const receipt = await test.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        // Replay the step as a call at the parent block to recover the revert reason.
        let reason = "reverted";
        try {
          await test.call({ account: HOLDER, to: s.target, data: s.calldata, value: BigInt(s.value ?? "0"), blockNumber: receipt.blockNumber - 1n });
        } catch (err) {
          reason = (err as Error).message.split("\n").slice(0, 3).join(" | ");
        }
        const tx = await test.getTransaction({ hash });
        check(`${label} step ${s.step} (${s.description})`, false, `${reason}; gas limit ${tx.gas}, used ${receipt.gasUsed}`);
        return false;
      }
      check(`${label} step ${s.step}: ${s.description}`, true);
    } catch (err) {
      check(`${label} step ${s.step} (${s.description})`, false, (err as Error).message.split("\n")[0]);
      return false;
    }
  }
  return true;
}

const usdcOf = async (a: `0x${string}`) =>
  (await test.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [a] })) as bigint;
const sharesOf = async (a: `0x${string}`) =>
  (await test.readContract({ address: GBLIN_VAULT, abi: ERC20_ABI, functionName: "balanceOf", args: [a] })) as bigint;

async function main(): Promise<void> {
  await test.impersonateAccount({ address: HOLDER });
  await test.setBalance({ address: HOLDER, value: parseUnits("1", 18) });

  // ── 1. exit to USDC just in time ──────────────────────────────────────────
  const usdcBefore = await usdcOf(HOLDER);
  const sharesBefore = await sharesOf(HOLDER);
  const jit = await call(handleJitSwap, { usdc_needed: "1", wallet_address: HOLDER });
  check("the exit returns three steps", Array.isArray(jit.steps) && jit.steps.length === 3, String(jit.steps?.length));
  check("the Zap step carries an explicit gas limit", Number((jit.steps as Step[])[1]?.gas) >= 1_013_267);
  const exited = await run(jit.steps as Step[], "exit");
  const usdcAfterExit = await usdcOf(HOLDER);
  const gotUsdc = usdcAfterExit - usdcBefore;
  check("the exit delivers at least the USDC asked for", exited && gotUsdc >= parseUnits("1", 6), formatUnits(gotUsdc, 6));
  check("the exit spent shares", (await sharesOf(HOLDER)) < sharesBefore);

  // ── 2. invest the USDC just obtained back into GBLIN ──────────────────────
  const invested = gotUsdc > 0n ? gotUsdc : parseUnits("1", 6);
  const sharesBeforeInvest = await sharesOf(HOLDER);
  const inv = await call(handleInvest, { usdc_amount: formatUnits(invested, 6), wallet_address: HOLDER });
  check("the investment returns two steps", Array.isArray(inv.steps) && inv.steps.length === 2, String(inv.steps?.length));
  check("the Zap step carries an explicit gas limit", Number((inv.steps as Step[])[1]?.gas) > 0);
  const ok = await run(inv.steps as Step[], "invest");
  const newShares = (await sharesOf(HOLDER)) - sharesBeforeInvest;
  check("the investment mints shares", ok && newShares > 0n, formatUnits(newShares, 18));
  check("the investment spent the USDC", (await usdcOf(HOLDER)) < usdcAfterExit);

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
