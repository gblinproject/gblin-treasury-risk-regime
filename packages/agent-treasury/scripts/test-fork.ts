/**
 * End-to-end test of the treasury against a fork of Base.
 *
 * Run:  anvil --fork-url <base rpc> --port 8556 --silent &
 *       GBLIN_RPC_URL=http://127.0.0.1:8556 npx tsx scripts/test-fork.ts
 *
 * A fresh wallet is funded with ETH and 100 USDC on the fork (USDC balance storage slot 9). Then, in
 * order: the surplus above the reserve is parked in GBLIN; a payment need larger than the reserve pulls
 * USDC back from GBLIN; the vault's cooldown after the wallet's own mint is honoured; an x402 invoice
 * served by a local mock (the challenge bytes of gblin.digital) is paid with a signature the mock
 * verifies, after an automatic refill; and a price above the policy cap is refused before signing.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createTestClient, createWalletClient, encodeFunctionData, http, keccak256, encodeAbiParameters, pad, parseAbi, parseUnits, publicActions, toHex, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { createTreasury, createTreasuryFetch, fromAccount } from "../src/index.js";
import { GBLIN_VAULT, USDC } from "../src/config.js";

const RPC = process.env.GBLIN_RPC_URL ?? "http://127.0.0.1:8556";
const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) }).extend(publicActions);

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) { passed += 1; console.log(`  ok      ${name}`); }
  else { failures.push(name); console.log(`  FAILED  ${name} ${detail}`); }
}

/** USDC on Base keeps balances in storage slot 9 of the proxy (verified on the fork). */
async function setUsdc(address: Hex, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [address, 9n]));
  await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(amount), { size: 32 }) });
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: account.address, value: parseUnits("0.05", 18) });
  await setUsdc(account.address, parseUnits("100", 6));

  const log: string[] = [];
  const treasury = createTreasury({
    signer: fromAccount(account, RPC),
    rpcUrl: RPC,
    policy: { reserveUsdc: 10, minParkUsdc: 5, maxExitUsdc: 50, maxPayUsdc: 1, riskGate: false },
    log: (l) => log.push(l),
  });

  // 1. status
  const s0 = await treasury.status();
  check("status reads 100 USDC and no GBLIN", Number(s0.usdc) === 100 && Number(s0.gblin) === 0, JSON.stringify(s0));
  check("status computes the surplus above the reserve", Number(s0.surplusUsdc) === 90, s0.surplusUsdc);
  check("status allows parking", s0.canPark, s0.canParkReason);

  // 2. park the surplus
  const park = await treasury.park();
  check("park mints GBLIN with the surplus", park.action === "parked" && Number(park.gblinAfter) > 0, JSON.stringify(park));
  check("park leaves the reserve in USDC", Math.abs(Number(park.usdcAfter) - 10) < 0.000001, park.usdcAfter);
  check("park sends two transactions (approve, zap)", park.txHashes.length === 2, String(park.txHashes.length));

  // 3. a second park does nothing: the surplus is gone
  const park2 = await treasury.park();
  check("a second park is a no-op", park2.action === "none", park2.reason);

  // 4. a need above the reserve pulls USDC back from GBLIN, right away: a mint through the Zap leaves no
  //    redemption cooldown on the wallet (the vault writes it only to an account that mints for itself).
  const cd0 = await treasury.status();
  check("no cooldown after parking through the Zap", cd0.cooldownSecondsRemaining === 0, String(cd0.cooldownSecondsRemaining));
  const ensure = await treasury.ensureUsdc(15);
  check("ensureUsdc exits GBLIN when USDC is short", ensure.action === "exited" && Number(ensure.usdcAfter) >= 15, JSON.stringify(ensure));
  check("the exit sends three transactions (approve, zap, swap)", ensure.txHashes.length === 3, String(ensure.txHashes.length));
  check("the exit sold GBLIN", Number(ensure.gblinAfter) < Number(ensure.gblinBefore), `${ensure.gblinBefore} -> ${ensure.gblinAfter}`);
  const ensure2 = await treasury.ensureUsdc(12);
  check("ensureUsdc is a no-op when USDC already covers the amount", ensure2.action === "none", ensure2.reason);

  // 5. the cooldown after a mint the wallet makes for itself, directly on the vault, is honoured.
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
  const mintHash = await wallet.sendTransaction({ to: GBLIN_VAULT, value: parseUnits("0.001", 18), data: encodeFunctionData({ abi: parseAbi(["function buyGBLIN(uint256 minOut) payable"]), functionName: "buyGBLIN", args: [0n] }), gas: 1_100_000n });
  await test.mine({ blocks: 1 });
  const mintReceipt = await test.getTransactionReceipt({ hash: mintHash });
  check("a direct mint on the vault confirms", mintReceipt.status === "success");
  await setUsdc(account.address, parseUnits("1", 6));
  let cooldownMsg = "";
  try { await treasury.ensureUsdc(5); } catch (err) { cooldownMsg = (err as Error).message; }
  check("an exit during the cooldown is refused with the time left", /cooldown/i.test(cooldownMsg) && /\d+ more seconds/.test(cooldownMsg), cooldownMsg.slice(0, 160));
  await test.increaseTime({ seconds: 60 });
  await test.mine({ blocks: 1 });
  const afterCooldown = await treasury.ensureUsdc(5);
  check("after the cooldown the exit goes through", afterCooldown.action === "exited" && Number(afterCooldown.usdcAfter) >= 5, JSON.stringify(afterCooldown).slice(0, 200));

  // 6. an x402 invoice served by a local mock: real challenge bytes, amount 0.5 USDC, signature verified.
  const fixture = JSON.parse(readFileSync(new URL("../../../../GBLIN_WEBAPP/test/x402-golden/attestation.json.json", import.meta.url), "utf8")) as { body: string; headers: Record<string, string> };
  const challenge = JSON.parse(fixture.body) as { accepts: Array<Record<string, unknown>>; resource: Record<string, unknown> };
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const price = 500_000n; // 0.5 USDC
  challenge.accepts = challenge.accepts.map((a) => ({ ...a, amount: price.toString(), payTo }));
  const seen: { from?: string; value?: string; signatureValid?: boolean; requests: number } = { requests: 0 };
  const server = createServer(async (req, res) => {
    seen.requests += 1;
    const sig = req.headers["payment-signature"] ?? req.headers["x-payment"];
    if (!sig) {
      const body = JSON.stringify({ ...challenge, resource: { ...challenge.resource, url: `http://127.0.0.1:${port}/paid` } });
      res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(body).toString("base64") });
      res.end(body);
      return;
    }
    const payload = JSON.parse(Buffer.from(String(sig), "base64").toString()) as { payload: { signature: Hex; authorization: Record<string, string> } };
    const auth = payload.payload.authorization;
    seen.from = auth.from; seen.value = auth.value;
    seen.signatureValid = await verifyTypedData({
      address: auth.from as Hex,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] },
      primaryType: "TransferWithAuthorization",
      message: { from: auth.from as Hex, to: auth.to as Hex, value: BigInt(auth.value!), validAfter: BigInt(auth.validAfter!), validBefore: BigInt(auth.validBefore!), nonce: auth.nonce as Hex },
      signature: payload.payload.signature,
    });
    res.writeHead(200, { "content-type": "application/json", "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "00".repeat(32), network: "eip155:8453" })).toString("base64") });
    res.end(JSON.stringify({ ok: true, regime: "calm" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  await setUsdc(account.address, parseUnits("0.2", 6)); // below the 0.5 the invoice asks
  await test.increaseTime({ seconds: 60 }); await test.mine({ blocks: 1 });
  const before = await treasury.status();
  const paidFetch = createTreasuryFetch(treasury);
  const res = await paidFetch(`http://127.0.0.1:${port}/paid`);
  const after = await treasury.status();
  check("the invoice is paid: HTTP 200 from the mock", res.status === 200, String(res.status));
  check("the mock received a signed authorization from the agent's wallet", seen.from?.toLowerCase() === account.address.toLowerCase(), String(seen.from));
  check("the authorization is for exactly the price asked", seen.value === price.toString(), String(seen.value));
  check("the EIP-712 signature verifies against the USDC domain", seen.signatureValid === true);
  check("USDC was refilled from GBLIN before signing", Number(before.usdc) < 0.5 && Number(after.usdc) >= 0.5, `${before.usdc} -> ${after.usdc}`);
  check("GBLIN went down by the refill", Number(after.gblin) < Number(before.gblin), `${before.gblin} -> ${after.gblin}`);
  check("the mock saw the free probe and the paid retry", seen.requests === 2, String(seen.requests));

  // 7. a price above the cap is refused before anything is signed
  seen.requests = 0; seen.from = undefined;
  const capped = createTreasuryFetch(treasury, { maxPayUsdc: 0.1 });
  let refused = "";
  let cappedStatus = 0;
  try { const r2 = await capped(`http://127.0.0.1:${port}/paid`); cappedStatus = r2.status; } catch (err) { refused = (err as Error).message; }
  check("a price above the cap is refused (error or the 402 comes back unpaid)", /cap/i.test(refused) || cappedStatus === 402, refused || String(cappedStatus));
  check("nothing was signed for the refused payment", seen.from === undefined, String(seen.from));

  server.close();
  console.log(`\nlog lines: ${log.length}`);
  console.log(`=== ${passed} checks passed, ${failures.length} failed ===`);
  if (failures.length) { console.log("failed:", failures.join(" · ")); process.exit(1); }
}

main().catch((err) => { console.error("error:", err); process.exit(1); });
