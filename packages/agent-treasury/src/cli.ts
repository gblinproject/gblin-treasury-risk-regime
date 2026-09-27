#!/usr/bin/env node
/**
 * gblin-treasury — the treasury from the command line, for agents that run shell commands.
 *
 *   gblin-treasury status [--json]
 *   gblin-treasury park [--json]
 *   gblin-treasury ensure-usdc <amount> [--json]
 *   gblin-treasury pay <url> [-X <method>] [-d <json>] [--max-amount <atomic USDC>] [--json]
 *   gblin-treasury run [--json]            one policy pass: park the surplus if the policy allows it
 *
 * Environment:
 *   GBLIN_AGENT_PRIVATE_KEY   hex private key of the agent wallet (required for park, ensure-usdc, pay, run)
 *   GBLIN_AGENT_ADDRESS       address to read for `status` when no key is configured
 *   GBLIN_RPC_URL             preferred Base RPC endpoint (optional)
 *   GBLIN_RESERVE_USDC, GBLIN_MIN_PARK_USDC, GBLIN_MAX_EXIT_USDC, GBLIN_MAX_PAY_USDC, GBLIN_MIN_GAS_ETH,
 *   GBLIN_RISK_GATE=false     policy overrides (optional)
 *
 * Every command prints one JSON object with --json; exit code 0 on success, 1 on a refusal or error.
 */

import { parseArgs } from "node:util";
import { formatUnits, isAddress, isHex, type Address, type Hex } from "viem";

import { makeClient } from "./chain.js";
import { readBalances, readPrices, readRegime } from "./quotes.js";
import { fromPrivateKey } from "./signer.js";
import { Treasury, DEFAULT_POLICY, type TreasuryPolicy } from "./treasury.js";
import { createTreasuryFetch } from "./x402.js";

function policyFromEnv(): Partial<TreasuryPolicy> {
  const num = (k: string) => (process.env[k] !== undefined && process.env[k] !== "" ? Number(process.env[k]) : undefined);
  const p: Partial<TreasuryPolicy> = {};
  const r = num("GBLIN_RESERVE_USDC"); if (r !== undefined) p.reserveUsdc = r;
  const m = num("GBLIN_MIN_PARK_USDC"); if (m !== undefined) p.minParkUsdc = m;
  const e = num("GBLIN_MAX_EXIT_USDC"); if (e !== undefined) p.maxExitUsdc = e;
  const y = num("GBLIN_MAX_PAY_USDC"); if (y !== undefined) p.maxPayUsdc = y;
  const g = num("GBLIN_MIN_GAS_ETH"); if (g !== undefined) p.minGasEth = g;
  if (process.env.GBLIN_RISK_GATE === "false") p.riskGate = false;
  for (const [k, v] of Object.entries(p)) if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`Policy value ${k} is not a number.`);
  return p;
}

function out(json: boolean, payload: Record<string, unknown>, human: string[]): void {
  if (json) console.log(JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else console.log(human.join("\n"));
}

function treasuryFromEnv(): Treasury {
  const key = process.env.GBLIN_AGENT_PRIVATE_KEY;
  if (!key || !isHex(key) || key.length !== 66) throw new Error("GBLIN_AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key.");
  return new Treasury({ signer: fromPrivateKey(key as Hex, process.env.GBLIN_RPC_URL), rpcUrl: process.env.GBLIN_RPC_URL, policy: policyFromEnv(), log: (l) => console.error(`[treasury] ${l}`) });
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      method: { type: "string", short: "X" },
      data: { type: "string", short: "d" },
      "max-amount": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, arg] = positionals;
  const json = Boolean(values.json);
  if (values.help || !command) {
    console.log("usage: gblin-treasury <status|park|ensure-usdc <amount>|pay <url>|run> [--json]");
    return values.help ? 0 : 1;
  }

  if (command === "status") {
    const key = process.env.GBLIN_AGENT_PRIVATE_KEY;
    if (key) {
      const s = await treasuryFromEnv().status();
      out(json, { ...s }, [
        `address   ${s.address}`,
        `USDC      ${s.usdc}   (reserve ${s.reserveUsdc}, surplus ${s.surplusUsdc})`,
        `GBLIN     ${s.gblin}   (~${s.gblinValueUsd} USD at NAV ${s.navUsd})`,
        `ETH       ${s.eth}`,
        `total     ~${s.totalUsd} USD`,
        `regime    ${s.regime}${s.navReliable ? "" : "   NAV not reliable"}${s.cooldownSecondsRemaining ? `   cooldown ${s.cooldownSecondsRemaining}s` : ""}`,
        `park      ${s.canPark ? "allowed" : "not now"}: ${s.canParkReason}`,
      ]);
      return 0;
    }
    const address = process.env.GBLIN_AGENT_ADDRESS;
    if (!address || !isAddress(address)) throw new Error("Set GBLIN_AGENT_PRIVATE_KEY, or GBLIN_AGENT_ADDRESS for a read-only status.");
    const client = makeClient(process.env.GBLIN_RPC_URL);
    const [b, p, r] = await Promise.all([readBalances(client, address as Address), readPrices(client), readRegime()]);
    const payload = { address, usdc: formatUnits(b.usdc, 6), gblin: formatUnits(b.gblin, 18), eth: formatUnits(b.eth, 18), navUsd: p.navUsd.toFixed(4), regime: r.regime, readOnly: true };
    out(json, payload, [`address ${address}`, `USDC ${payload.usdc}`, `GBLIN ${payload.gblin} (NAV ${payload.navUsd} USD)`, `ETH ${payload.eth}`, `regime ${r.regime}`]);
    return 0;
  }

  if (command === "park" || command === "run") {
    const t = treasuryFromEnv();
    const res = await t.park();
    out(json, { command, ...res }, [`${res.action}: ${res.reason}`, `USDC ${res.usdcBefore} -> ${res.usdcAfter}`, `GBLIN ${res.gblinBefore} -> ${res.gblinAfter}`, ...res.txHashes.map((h) => `tx ${h}`)]);
    return 0;
  }

  if (command === "ensure-usdc") {
    if (!arg || !/^\d+(\.\d+)?$/.test(arg)) throw new Error("ensure-usdc needs a positive decimal USDC amount, for example 2.50");
    const t = treasuryFromEnv();
    const res = await t.ensureUsdc(arg);
    out(json, { command, amount: arg, ...res }, [`${res.action}: ${res.reason}`, `USDC ${res.usdcBefore} -> ${res.usdcAfter}`, `GBLIN ${res.gblinBefore} -> ${res.gblinAfter}`, ...res.txHashes.map((h) => `tx ${h}`)]);
    return 0;
  }

  if (command === "pay") {
    if (!arg || !/^https?:\/\/[^\s;|`$]+$/.test(arg)) throw new Error("pay needs an http(s) URL with no spaces or shell characters.");
    const t = treasuryFromEnv();
    const maxRaw = values["max-amount"];
    const maxPayUsdc = maxRaw !== undefined ? (/^\d+$/.test(maxRaw) ? Number(maxRaw) / 1e6 : NaN) : undefined;
    if (maxPayUsdc !== undefined && !Number.isFinite(maxPayUsdc)) throw new Error("--max-amount must be a positive integer in atomic USDC units (1000000 = 1 USDC).");
    const paidFetch = createTreasuryFetch(t, maxPayUsdc !== undefined ? { maxPayUsdc } : {});
    const method = (values.method ?? "GET").toUpperCase();
    const init: RequestInit = { method, headers: { accept: "application/json" } };
    if (values.data !== undefined) {
      JSON.parse(values.data); // must be valid JSON
      init.body = values.data;
      init.headers = { ...(init.headers as Record<string, string>), "content-type": "application/json" };
    }
    const res = await paidFetch(arg, init);
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const paymentResponse = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    out(json, { command, url: arg, status: res.status, paymentResponse, body }, [`HTTP ${res.status}${paymentResponse ? "  (paid)" : ""}`, typeof body === "string" ? body : JSON.stringify(body, null, 2)]);
    return res.ok ? 0 : 1;
  }

  throw new Error(`Unknown command "${command}". Commands: status, park, ensure-usdc, pay, run.`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const message = (err as Error).message ?? String(err);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ error: message }));
    else console.error(`error: ${message}`);
    process.exit(1);
  });
