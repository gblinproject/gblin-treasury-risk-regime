/**
 * End-to-end test of prepare_action, preview_steps and get_transaction_status against a fork of Base.
 *
 * Run:  anvil --fork-url <base rpc> --port 8555 --silent &
 *       GBLIN_RPC_URL=http://127.0.0.1:8555 npx tsx scripts/test-actions-fork.ts
 *
 * For every action: prepare the steps, simulate them, send them exactly as returned from a real holder
 * impersonated on the fork, then read the outcome back with get_transaction_status. The simulation must
 * agree with what the chain then does: a preview that says "would succeed" must be followed by success,
 * and the balance changes it predicts must have the same sign as the real ones.
 */

import { createTestClient, http, publicActions, walletActions, parseUnits, type Hex } from "viem";
import { base } from "viem/chains";

import { handlePrepareAction, handlePreviewSteps, handleTransactionStatus } from "../src/actions.js";
import { WETH } from "../src/config.js";

const RPC = process.env.GBLIN_RPC_URL ?? "http://127.0.0.1:8555";
/** A holder with shares and ETH on Base; impersonated only on the fork. */
const HOLDER = "0x30590c0D05c26562d7296CE3D927d3418d2e6dcA" as const;

const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) }).extend(publicActions).extend(walletActions);

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

async function call(fn: (a: unknown) => Promise<unknown>, args: unknown): Promise<{ ok: boolean; data: Record<string, any>; text: string }> {
  const res = (await fn(args)) as { structuredContent?: Record<string, any>; content?: { text: string }[]; isError?: boolean };
  return { ok: !res.isError, data: res.structuredContent ?? {}, text: res.content?.[0]?.text ?? "" };
}

async function send(steps: Step[]): Promise<Hex[]> {
  const hashes: Hex[] = [];
  for (const s of steps) {
    const hash = await test.sendTransaction({
      account: HOLDER,
      to: s.target,
      data: s.calldata,
      value: BigInt(s.value ?? "0"),
      ...(s.gas ? { gas: BigInt(s.gas) } : {}),
      chain: base,
    });
    await test.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  return hashes;
}

/** Prepare, preview, send, then read every transaction back. */
async function roundTrip(label: string, args: Record<string, unknown>, expectDelta: Record<string, "+" | "-">): Promise<void> {
  const prepared = await call(handlePrepareAction, { wallet_address: HOLDER, ...args });
  check(`${label}: prepared`, prepared.ok && Array.isArray(prepared.data.steps), prepared.text.slice(0, 200));
  if (!prepared.ok) return;
  const steps = prepared.data.steps as Step[];

  const preview = await call(handlePreviewSteps, { from: HOLDER, steps });
  check(`${label}: preview says it would succeed`, preview.ok && preview.data.would_succeed === true, preview.text.slice(0, 400));
  const predicted = new Map<string, string>((preview.data.balance_changes ?? []).map((b: any) => [b.symbol, b.delta]));
  for (const [symbol, sign] of Object.entries(expectDelta)) {
    const d = predicted.get(symbol);
    check(`${label}: preview predicts ${symbol} ${sign}`, d !== undefined && (sign === "+" ? !d.startsWith("-") : d.startsWith("-")), String(d));
  }

  let hashes: Hex[] = [];
  try {
    hashes = await send(steps);
  } catch (err) {
    check(`${label}: sent`, false, (err as Error).message.split("\n")[0]);
    return;
  }
  // Read every transaction back and add up what each one moved.
  const real = new Map<string, string>();
  let allSucceeded = true;
  for (const hash of hashes) {
    const status = await call(handleTransactionStatus, { hash });
    if (!(status.ok && status.data.status === "success")) allSucceeded = false;
    for (const b of status.data.balance_changes ?? []) {
      const prev = Number(real.get(b.symbol) ?? "0");
      real.set(b.symbol, String(prev + Number(b.delta)));
    }
  }
  check(`${label}: status reports success for every step`, allSucceeded);
  for (const [symbol, sign] of Object.entries(expectDelta)) {
    if (symbol === "ETH") continue; // receipts carry no native-transfer logs; the fee also moves ETH
    const d = real.get(symbol);
    check(`${label}: status shows ${symbol} ${sign}`, d !== undefined && (sign === "+" ? !d.startsWith("-") : d.startsWith("-")), String(d));
  }
}

async function main(): Promise<void> {
  await test.impersonateAccount({ address: HOLDER });
  await test.setBalance({ address: HOLDER, value: parseUnits("2", 18) });

  await roundTrip("mint with ETH", { action: "mint_with_eth", amount: "0.002" }, { GBLIN: "+" });

  // WETH first, then mint with it.
  await test.sendTransaction({ account: HOLDER, to: WETH, value: parseUnits("0.002", 18), data: "0xd0e30db0", chain: base });
  await roundTrip("mint with WETH", { action: "mint_with_weth", amount: "0.002" }, { GBLIN: "+", WETH: "-" });

  // The redemption cooldown after one's own mint: let it pass.
  await test.increaseTime({ seconds: 60 });
  await test.mine({ blocks: 1 });

  await roundTrip("redeem in kind", { action: "redeem_in_kind", amount: "0.001" }, { GBLIN: "-" });
  await roundTrip("exit to ETH", { action: "exit_to_eth", amount: "0.01" }, { GBLIN: "-", ETH: "+" });
  await roundTrip("exit to USDC", { action: "exit_to_usdc", amount: "1" }, { GBLIN: "-", USDC: "+" });
  await roundTrip("mint with USDC", { action: "mint_with_usdc", amount: "1" }, { GBLIN: "+", USDC: "-" });

  // bid: either a clean answer that no row can be bid on, or steps that simulate.
  const bid = await call(handlePrepareAction, { action: "bid", wallet_address: HOLDER });
  check("bid: clean answer when nothing can be bid, or steps", bid.ok ? Array.isArray(bid.data.steps) : /auction|row/i.test(bid.text), bid.text.slice(0, 200));

  // A step that must fail: redeem more shares than the wallet holds.
  const tooMuch = await call(handlePrepareAction, { action: "redeem_in_kind", wallet_address: HOLDER, amount: "1000000" });
  check("an oversized redemption is flagged before simulation", tooMuch.ok && (tooMuch.data.warnings ?? []).length > 0);
  const failing = await call(handlePreviewSteps, { from: HOLDER, steps: tooMuch.data.steps });
  check("the preview reports it would fail", failing.ok && failing.data.would_succeed === false && failing.data.first_failing_step === 1, failing.text.slice(0, 300));

  // A Zap step sent with too little gas: the preview must say the limit is not enough.
  const exit = await call(handlePrepareAction, { action: "exit_to_eth", wallet_address: HOLDER, amount: "0.01" });
  const starved = (exit.data.steps as Step[]).map((s) => (s.gas ? { ...s, gas: "300000" } : s));
  const lowGas = await call(handlePreviewSteps, { from: HOLDER, steps: starved });
  const zapStep = (lowGas.data.steps ?? [])[1] ?? {};
  check("a starved gas limit is reported as not enough", lowGas.ok && zapStep.gas_limit_enough === false, lowGas.text.slice(0, 300));
  check("it names the cause: out of gas", /out of gas/i.test(String(zapStep.error)), String(zapStep.error));
  check("it recommends at least what the Zap exit needs", Number(zapStep.recommended_gas_limit) >= 1_013_267, String(zapStep.recommended_gas_limit));

  // The same Zap step with no gas at all: the preview must recommend a limit that really passes.
  const bare = (exit.data.steps as Step[]).map(({ gas: _g, ...rest }) => rest);
  const noGas = await call(handlePreviewSteps, { from: HOLDER, steps: bare });
  const bareZap = (noGas.data.steps ?? [])[1] ?? {};
  check("a Zap step without gas carries a warning", typeof bareZap.gas_warning === "string", JSON.stringify(bareZap).slice(0, 200));
  const rec = BigInt(bareZap.recommended_gas_limit ?? 0);
  const withRec = await call(handlePreviewSteps, { from: HOLDER, steps: bare.map((st, k) => (k === 1 ? { ...st, gas: rec.toString() } : st)) });
  check("the recommended limit makes the step succeed", withRec.ok && withRec.data.would_succeed === true, withRec.text.slice(0, 300));
  const justUnder = await call(handlePreviewSteps, {
    from: HOLDER,
    steps: bare.map((st, k) => (k === 1 ? { ...st, gas: String(Number(Number(bareZap.gas_used) * 1.2).toFixed(0)) } : st)),
  });
  check("the naive limit (gas used + 20%) is shown to fail", justUnder.ok && justUnder.data.would_succeed === false, justUnder.text.slice(0, 300));

  // Status of a hash nobody knows.
  const unknown = await call(handleTransactionStatus, { hash: "0x" + "ab".repeat(32) });
  check("an unknown hash is reported as not found", unknown.ok && unknown.data.status === "not_found", unknown.text.slice(0, 200));

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
