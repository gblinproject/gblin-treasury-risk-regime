/**
 * End-to-end test of the gasless payment tools against a fork of Base.
 *
 * Run:  anvil --fork-url <base rpc> --port 8555 --silent &
 *       GBLIN_RPC_URL=http://127.0.0.1:8555 npx tsx scripts/test-payments-fork.ts
 *
 * Nothing here touches mainnet. The fork carries the real vault, so the signatures, the EIP-712
 * domain and the settlement rules are the contract's own, not a mock's.
 *
 * What it proves, in order:
 *   1. an authorization prepared by the tool is signed and accepted by the token;
 *   2. the payer spends no ETH: a third party carries it;
 *   3. the verifier agrees with the chain in every failure mode, before gas is spent;
 *   4. a used authorization cannot be replayed, and a receive authorization cannot be front-run.
 */

import { createTestClient, createWalletClient, http, publicActions, walletActions, parseUnits, formatUnits, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";

import { GBLIN_ABI, ERC20_ABI } from "../src/abi.js";

/** The server's ABI has no `transfer`: it never moves funds. The fork setup needs one. */
const TRANSFER_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
] as const;
import { GBLIN_VAULT } from "../src/config.js";
import { handlePreparePayment, handleRelayPayment, handleVerifyAuthorization } from "../src/payments.js";

const RPC = process.env.GBLIN_RPC_URL ?? "http://127.0.0.1:8555";
/** A holder with a live balance on Base; impersonated only on the fork. */
const HOLDER = "0x30590c0D05c26562d7296CE3D927d3418d2e6dcA" as const;

const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) }).extend(publicActions).extend(walletActions);


/** Handlers return the MCP envelope; the tests read the structured payload out of it. */
async function call(fn: (a: Record<string, unknown>) => Promise<unknown>, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = (await fn(args)) as { structuredContent?: Record<string, unknown>; content?: { text: string }[]; isError?: boolean };
  if (res.isError) throw new Error(`handler error: ${res.content?.[0]?.text ?? "unknown"}`);
  if (!res.structuredContent) throw new Error("the handler returned no structuredContent");
  return res.structuredContent as Record<string, any>;
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

async function fund(address: `0x${string}`): Promise<void> {
  await test.setBalance({ address, value: parseUnits("1", 18) });
}

async function main(): Promise<void> {
  const payer = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey());
  const relayer = privateKeyToAccount(generatePrivateKey());
  const payerWallet = createWalletClient({ account: payer, chain: base, transport: http(RPC) });
  const relayerWallet = createWalletClient({ account: relayer, chain: base, transport: http(RPC) });
  const recipientWallet = createWalletClient({ account: recipient, chain: base, transport: http(RPC) });

  // The payer receives shares and stays at zero ETH for the whole test: that is the point.
  await test.impersonateAccount({ address: HOLDER });
  await fund(HOLDER);
  await test.writeContract({
    account: HOLDER,
    address: GBLIN_VAULT,
    abi: TRANSFER_ABI,
    functionName: "transfer",
    args: [payer.address, parseUnits("2", 18)],
    chain: base,
  });
  await fund(relayer.address);
  await fund(recipient.address);

  const payerShares = (await test.readContract({
    address: GBLIN_VAULT, abi: ERC20_ABI, functionName: "balanceOf", args: [payer.address],
  })) as bigint;
  check("the payer holds shares and no ETH", payerShares === parseUnits("2", 18) && (await test.getBalance({ address: payer.address })) === 0n);

  // ── 1. prepare ────────────────────────────────────────────────────────────
  const prepared = (await call(handlePreparePayment, {
    from: payer.address, to: recipient.address, amount_gblin: "0.5", method: "receive",
  })) as Record<string, any>;
  check("the EIP-712 domain comes from the contract", prepared.typed_data.domain.verifyingContract.toLowerCase() === GBLIN_VAULT.toLowerCase());
  check("the domain carries the token name and version", typeof prepared.typed_data.domain.name === "string" && prepared.typed_data.domain.name.length > 0);
  check("the signed type is ReceiveWithAuthorization", prepared.typed_data.primaryType === "ReceiveWithAuthorization");
  check("the x402 payload declares the exact scheme", prepared.x402_payload.scheme === "exact" && prepared.x402_payload.network === "eip155:8453");
  check("the seller block carries the domain as extra", prepared.x402_accepts_for_sellers.extra.name === prepared.typed_data.domain.name);
  check("the payer balance is reported sufficient", prepared.payer_balance.sufficient === true);

  // ── 2. sign ───────────────────────────────────────────────────────────────
  const signature = await payerWallet.signTypedData({
    domain: prepared.typed_data.domain,
    types: prepared.typed_data.types,
    primaryType: prepared.typed_data.primaryType,
    message: prepared.typed_data.message,
  });

  // ── 3. verify before spending gas ─────────────────────────────────────────
  const verdict = (await call(handleVerifyAuthorization, {
    authorization: prepared.authorization, signature, method: "receive",
  })) as Record<string, any>;
  check("the verifier says it would settle", verdict.would_settle === true, JSON.stringify(verdict.failures));
  check("the recovered signer is the payer", String(verdict.checks.recovered_signer).toLowerCase() === payer.address.toLowerCase());
  check("the digest matches the prepared one", verdict.digest === prepared.digest);
  check("the calldata is ready", typeof verdict.submit?.calldata === "string" && verdict.submit.calldata.startsWith("0x"));
  check("it states only the recipient may submit", verdict.submit.who_may_submit.toLowerCase() === recipient.address.toLowerCase());

  // ── 4. an outsider cannot carry a receive authorization ───────────────────
  let outsiderRejected = false;
  try {
    await relayerWallet.sendTransaction({ to: GBLIN_VAULT, data: verdict.submit.calldata as Hex });
  } catch { outsiderRejected = true; }
  check("an outsider cannot carry a receive authorization", outsiderRejected);

  // ── 5. the recipient carries it: the payer pays no gas ────────────────────
  const payerEthBefore = await test.getBalance({ address: payer.address });
  const hash = await recipientWallet.sendTransaction({ to: GBLIN_VAULT, data: verdict.submit.calldata as Hex });
  const receipt = await test.waitForTransactionReceipt({ hash });
  check("the transaction succeeds", receipt.status === "success");
  const recipientShares = (await test.readContract({
    address: GBLIN_VAULT, abi: ERC20_ABI, functionName: "balanceOf", args: [recipient.address],
  })) as bigint;
  check("the recipient received the shares", recipientShares === parseUnits("0.5", 18), formatUnits(recipientShares, 18));
  check("the payer spent no ETH", (await test.getBalance({ address: payer.address })) === payerEthBefore && payerEthBefore === 0n);
  const used = (await test.readContract({
    address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "authorizationState", args: [payer.address, prepared.authorization.nonce],
  })) as boolean;
  check("the nonce is recorded as used", used === true);

  // ── 6. the verifier refuses what the chain would refuse ───────────────────
  const afterUse = (await call(handleVerifyAuthorization, {
    authorization: prepared.authorization, signature, method: "receive",
  })) as Record<string, any>;
  check("the verifier rejects the replay", afterUse.would_settle === false && afterUse.checks.nonce_already_used_or_cancelled === true);

  const wrongSigner = privateKeyToAccount(generatePrivateKey());
  const prepared2 = (await call(handlePreparePayment, {
    from: payer.address, to: recipient.address, amount_gblin: "0.1", method: "transfer",
  })) as Record<string, any>;
  const foreignSignature = await createWalletClient({ account: wrongSigner, chain: base, transport: http(RPC) }).signTypedData({
    domain: prepared2.typed_data.domain, types: prepared2.typed_data.types,
    primaryType: prepared2.typed_data.primaryType, message: prepared2.typed_data.message,
  });
  const wrong = (await call(handleVerifyAuthorization, {
    authorization: prepared2.authorization, signature: foreignSignature, method: "transfer",
  })) as Record<string, any>;
  check("a signature from another wallet is rejected", wrong.would_settle === false && wrong.checks.signature_valid === false);

  const tooBig = (await call(handlePreparePayment, {
    from: payer.address, to: recipient.address, amount_gblin: "999", method: "transfer",
  })) as Record<string, any>;
  check("an amount above the balance is reported insufficient", tooBig.payer_balance.sufficient === false);
  const tooBigSig = await payerWallet.signTypedData({
    domain: tooBig.typed_data.domain, types: tooBig.typed_data.types,
    primaryType: tooBig.typed_data.primaryType, message: tooBig.typed_data.message,
  });
  const tooBigVerdict = (await call(handleVerifyAuthorization, {
    authorization: tooBig.authorization, signature: tooBigSig, method: "transfer",
  })) as Record<string, any>;
  check("the verifier rejects it for insufficient balance", tooBigVerdict.would_settle === false && tooBigVerdict.checks.balance_sufficient === false);

  const expired = (await call(handlePreparePayment, {
    from: payer.address, to: recipient.address, amount_gblin: "0.1", method: "transfer", valid_for_seconds: 60,
  })) as Record<string, any>;
  const expiredSig = await payerWallet.signTypedData({
    domain: expired.typed_data.domain, types: expired.typed_data.types,
    primaryType: expired.typed_data.primaryType, message: expired.typed_data.message,
  });
  await test.increaseTime({ seconds: 3600 });
  await test.mine({ blocks: 1 });
  const expiredVerdict = (await call(handleVerifyAuthorization, {
    authorization: expired.authorization, signature: expiredSig, method: "transfer",
  })) as Record<string, any>;
  check("an expired authorization is rejected", expiredVerdict.would_settle === false && expiredVerdict.checks.expired === true);

  // ── 7. transfer method: anybody carries it ────────────────────────────────
  const open = (await call(handlePreparePayment, {
    from: payer.address, to: recipient.address, amount_gblin: "0.25", method: "transfer",
  })) as Record<string, any>;
  const openSig = await payerWallet.signTypedData({
    domain: open.typed_data.domain, types: open.typed_data.types,
    primaryType: open.typed_data.primaryType, message: open.typed_data.message,
  });
  const openVerdict = (await call(handleVerifyAuthorization, {
    authorization: open.authorization, signature: openSig, method: "transfer",
  })) as Record<string, any>;
  check("the verifier says anyone may submit it", openVerdict.submit?.who_may_submit === "anyone");
  const hash2 = await relayerWallet.sendTransaction({ to: GBLIN_VAULT, data: openVerdict.submit.calldata as Hex });
  const receipt2 = await test.waitForTransactionReceipt({ hash: hash2 });
  check("a third party carries it on chain", receipt2.status === "success");
  const finalRecipient = (await test.readContract({
    address: GBLIN_VAULT, abi: ERC20_ABI, functionName: "balanceOf", args: [recipient.address],
  })) as bigint;
  check("the recipient holds 0.75 shares in total", finalRecipient === parseUnits("0.75", 18), formatUnits(finalRecipient, 18));
  check("the payer is still at zero ETH after two payments", (await test.getBalance({ address: payer.address })) === 0n);

  // ── 8. the relay, when a relay is reachable (GBLIN_RELAY_URL on the fork) ────
  if (process.env.GBLIN_RELAY_URL) {
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const prepared = await call(handlePreparePayment, { from: payer.address, to: payee, amount_gblin: "0.1", relay: true });
    check("with relay, the method is transfer", prepared.method === "transfer");
    check("with relay, a fee authorization is prepared", typeof prepared.relay?.fee_typed_data === "object");
    const sign = (t: any) =>
      payerWallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    const payment = { authorization: prepared.authorization, signature: await sign(prepared.typed_data) };
    const fee = { authorization: prepared.relay.fee_authorization, signature: await sign(prepared.relay.fee_typed_data) };
    const relayed = (await handleRelayPayment({ payment, fee })) as { structuredContent?: Record<string, any>; content?: { text: string }[] };
    check("the relay settles it", relayed.structuredContent?.status === "settled", relayed.content?.[0]?.text?.slice(0, 300));
    const payeeShares = (await test.readContract({ address: GBLIN_VAULT, abi: ERC20_ABI, functionName: "balanceOf", args: [payee] })) as bigint;
    check("the payee received 0.1 through the relay", payeeShares === parseUnits("0.1", 18), formatUnits(payeeShares, 18));
    check("the payer still has no ETH after the relay", (await test.getBalance({ address: payer.address })) === 0n);
  } else {
    console.log("  skipped the relay checks: GBLIN_RELAY_URL is not set");
  }

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
