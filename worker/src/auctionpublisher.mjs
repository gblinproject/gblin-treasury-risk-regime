// Auction order publisher.
//
// The vault rebalances through a Dutch auction that CoW Protocol solvers fill. Each row being
// auctioned is registered on ComposableCoW as a conditional order: GblinAuctionOrder generates
// the discrete order for the current time bucket and the fill agent signs it through EIP-1271.
// Someone still has to take that discrete order to the CoW order book. CoW's hosted watch-tower
// is one such relay; this module is another, run by the protocol, in the same way Reserve runs
// its own relay for the auctions of its index tokens.
//
// The relay holds no key and no power over the vault. It reads the order the generator returns,
// exactly as any watch-tower would, and posts it. The order book re-verifies the signature
// against the fill agent, and the settlement contract re-checks price and amounts on chain, so a
// faulty relay can at worst fail to post. Nothing is stored: the public status page reads the
// chain and the order book live.

import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, pad, toHex } from "viem";

const COMPOSABLE_COW = "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74";
const FILL_AGENT = "0x0f4307A5Eb7D33d04Cb68fb0bA4d47a56C7E2fc8";
const ORDER_GENERATOR = "0x156Ffd19819e02d9809cED8fa1416EDCD31ddaB9";
const VAULT = "0xc2181d975c05c8c724b334bcED0764c0b86B1D53";
const LENS = "0xfCFea8027019E8551A1f09AD91532471F5D26f61";
const ORDER_BOOK = "https://api.cow.fi/base/api/v1";
const BUCKET_SECONDS = 300;

// The conditional orders registered on ComposableCoW for the fill agent. The app data hashes are
// the documents uploaded to the order book; each carries the pre-hook that opens the fill and the
// post-hook that settles it.
const ROWS = [
  {
    label: "cbBTC",
    index: 0,
    appDataVaultBuys: "0x9787a156235886f83fd0941b2b8847f35a011f3aea19ad9e19517f35a5fd5b6e",
    appDataVaultSells: "0xffa3df1f7858acd7be9b840afab564bd481fba255a6b9005db6b2344e14899df",
  },
  {
    label: "USDC",
    index: 2,
    appDataVaultBuys: "0xe8793fae38acbfc00432d8d3eaa455e3405b41e9b836921ec3089e81972caeba",
    appDataVaultSells: "0x7556318001887d62acd04d25d03f4a32e135d7f4f7b6918d29179df3ded7671b",
  },
];

const ORDER_TUPLE = {
  type: "tuple",
  components: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "bytes32" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "bytes32" },
    { name: "buyTokenBalance", type: "bytes32" },
  ],
};

const COMPOSABLE_COW_ABI = [
  {
    type: "function",
    name: "getTradeableOrderWithSignature",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "handler", type: "address" },
          { name: "salt", type: "bytes32" },
          { name: "staticInput", type: "bytes" },
        ],
      },
      { name: "offchainInput", type: "bytes" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [{ name: "order", ...ORDER_TUPLE }, { name: "signature", type: "bytes" }],
  },
  { type: "error", name: "OrderNotValid", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "PollTryNextBlock", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "PollTryAtBlock", inputs: [{ name: "blockNumber", type: "uint256" }, { name: "reason", type: "string" }] },
  { type: "error", name: "PollTryAtEpoch", inputs: [{ name: "timestamp", type: "uint256" }, { name: "reason", type: "string" }] },
  { type: "error", name: "PollNever", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "SingleOrderNotAuthed", inputs: [] },
  { type: "error", name: "ProofNotAuthed", inputs: [] },
];

const LENS_AUCTION_ABI = [
  {
    type: "function",
    name: "auction",
    stateMutability: "view",
    inputs: [{ name: "vault", type: "address" }, { name: "i", type: "uint256" }],
    outputs: [
      { name: "open", type: "bool" },
      { name: "premiumBps", type: "int256" },
      { name: "vaultBuysAsset", type: "bool" },
      { name: "gapEth", type: "uint256" },
    ],
  },
];

// keccak256 of the GPv2 marker strings, as the settlement contract stores them.
const KIND = {
  "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775": "sell",
  "0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc": "buy",
};
const BALANCE = {
  "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9": "erc20",
  "0xabee3b73373acd583a130924aad6dc38cfdc44ba0555ba94ce2ff63980ea0632": "external",
  "0x4ac99ace14ee0a5ef932dc609df0943ab7ac16b7583634612f8dc35a4289a6ce": "internal",
};

function conditionalParams(row) {
  const staticInput = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }] }],
    [[BigInt(row.index), row.appDataVaultBuys, row.appDataVaultSells, BUCKET_SECONDS]],
  );
  return { handler: ORDER_GENERATOR, salt: pad(toHex(row.index), { size: 32 }), staticInput };
}

// eth_call across the public endpoints. A revert is an answer, not a transport failure: it is
// returned as { revert } and not retried on the next endpoint.
async function ethCall(rpcs, to, data) {
  let lastError = "no endpoint";
  for (const url of rpcs) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
      if (!r.ok) { lastError = `${url} HTTP ${r.status}`; continue; }
      const body = await r.json();
      if (body.result !== undefined) return { result: body.result };
      const revertData = body.error?.data;
      if (typeof revertData === "string" && revertData.startsWith("0x")) return { revert: revertData };
      if (body.error && /revert/i.test(body.error.message || "")) return { revert: "0x", message: body.error.message };
      lastError = `${url} ${body.error?.message || "no result"}`;
    } catch (e) {
      lastError = `${url} ${e.message}`;
    }
  }
  return { error: lastError };
}

function describeRevert(data) {
  try {
    const e = decodeErrorResult({ abi: COMPOSABLE_COW_ABI, data });
    const reason = e.args?.find((a) => typeof a === "string");
    return reason ? `${e.errorName}: ${reason}` : e.errorName;
  } catch {
    return `unrecognised revert ${String(data).slice(0, 10)}`;
  }
}

// The discrete order the generator returns for a row right now, ready for the order book, or the
// reason there is none.
export async function currentOrder(rpcs, row) {
  const data = encodeFunctionData({
    abi: COMPOSABLE_COW_ABI,
    functionName: "getTradeableOrderWithSignature",
    args: [FILL_AGENT, conditionalParams(row), "0x", []],
  });
  const res = await ethCall(rpcs, COMPOSABLE_COW, data);
  if (res.error) return { row: row.label, order: null, reason: `read failed: ${res.error}` };
  if (res.revert !== undefined) return { row: row.label, order: null, reason: res.message || describeRevert(res.revert) };
  const [order, signature] = decodeFunctionResult({
    abi: COMPOSABLE_COW_ABI,
    functionName: "getTradeableOrderWithSignature",
    data: res.result,
  });
  const kind = KIND[order.kind.toLowerCase()];
  const sellTokenBalance = BALANCE[order.sellTokenBalance.toLowerCase()];
  const buyTokenBalance = BALANCE[order.buyTokenBalance.toLowerCase()];
  if (!kind || !sellTokenBalance || !buyTokenBalance) {
    return { row: row.label, order: null, reason: "order uses a kind or balance marker this relay does not know" };
  }
  return {
    row: row.label,
    order: {
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      validTo: Number(order.validTo),
      appData: order.appData,
      feeAmount: order.feeAmount.toString(),
      kind,
      partiallyFillable: order.partiallyFillable,
      sellTokenBalance,
      buyTokenBalance,
      signingScheme: "eip1271",
      signature,
      from: FILL_AGENT,
    },
    reason: null,
  };
}

// Orders already posted by this isolate, so a bucket is posted once rather than every minute.
// Best effort only: a new isolate posts again and the order book answers DuplicatedOrder.
const posted = new Map();

function orderKey(o) {
  return `${o.sellToken}:${o.buyToken}:${o.sellAmount}:${o.buyAmount}:${o.validTo}`;
}

export async function publishAuctionOrders(env, rpcs) {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, validTo] of posted) if (validTo < now) posted.delete(k);

  // The generator is read first, from Base. The order book is contacted only when there is an order to
  // take to it, so a closed auction -- the usual state -- sends nothing to CoW at all.
  const current = [];
  for (const row of ROWS) current.push([row, await currentOrder(rpcs, row)]);
  const results = [];
  if (!current.some(([, cur]) => cur.order)) {
    for (const [row, cur] of current) results.push({ row: row.label, action: "none", reason: cur.reason });
    console.log("auction publisher", JSON.stringify(results));
    return results;
  }

  // One live order per pair. Amounts move a little from one minute to the next (feeds, the vault's own
  // balances), so without this a new order would be posted every minute beside the previous one. Only
  // one of them can ever settle, and the order book limits the open orders per account. An order that
  // is filled or expires frees the pair on the next minute.
  const live = new Set();
  let bookRead = false;
  try {
    const r = await fetch(`${ORDER_BOOK}/account/${FILL_AGENT}/orders?limit=20`);
    if (r.ok) {
      bookRead = true;
      for (const o of await r.json()) {
        if (o.status === "open" && o.validTo > now) live.add(`${o.sellToken}:${o.buyToken}`.toLowerCase());
      }
    }
  } catch { /* falls back to the in-memory record below */ }

  for (const [row, cur] of current) {
    if (!cur.order) {
      results.push({ row: row.label, action: "none", reason: cur.reason });
      continue;
    }
    if (live.has(`${cur.order.sellToken}:${cur.order.buyToken}`.toLowerCase())) {
      results.push({ row: row.label, action: "order already open", validTo: cur.order.validTo });
      continue;
    }
    const key = orderKey(cur.order);
    if (!bookRead && posted.has(key)) {
      results.push({ row: row.label, action: "already posted", validTo: cur.order.validTo });
      continue;
    }
    try {
      const r = await fetch(`${ORDER_BOOK}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cur.order),
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      if (r.status === 201) {
        posted.set(key, cur.order.validTo);
        results.push({ row: row.label, action: "posted", uid: body, validTo: cur.order.validTo });
      } else if (r.status === 400 && body?.errorType === "DuplicatedOrder") {
        posted.set(key, cur.order.validTo);
        results.push({ row: row.label, action: "already in order book", validTo: cur.order.validTo });
      } else {
        results.push({ row: row.label, action: "rejected", status: r.status, error: body?.errorType || String(text).slice(0, 200), description: body?.description });
      }
    } catch (e) {
      results.push({ row: row.label, action: "post failed", error: e.message });
    }
  }
  console.log("auction publisher", JSON.stringify(results));
  return results;
}

// Public status: the auction on each row, the order the generator returns now, and the fill
// agent's recent orders as the order book lists them. Read live; nothing is cached server-side.
export async function publisherStatus(rpcs) {
  const rows = [];
  for (const row of ROWS) {
    const a = await ethCall(
      rpcs,
      LENS,
      encodeFunctionData({ abi: LENS_AUCTION_ABI, functionName: "auction", args: [VAULT, BigInt(row.index)] }),
    );
    let auction = null;
    if (a.result) {
      const [open, premiumBps, vaultBuysAsset, gapEth] = decodeFunctionResult({ abi: LENS_AUCTION_ABI, functionName: "auction", data: a.result });
      auction = { open, premium_bps: Number(premiumBps), vault_buys_asset: vaultBuysAsset, gap_wei: gapEth.toString() };
    }
    const cur = await currentOrder(rpcs, row);
    rows.push({
      row: row.label,
      index: row.index,
      auction,
      current_order: cur.order
        ? { sell_token: cur.order.sellToken, buy_token: cur.order.buyToken, sell_amount: cur.order.sellAmount, buy_amount: cur.order.buyAmount, valid_to: cur.order.validTo }
        : null,
      no_order_reason: cur.reason,
    });
  }
  let recent = null;
  try {
    const r = await fetch(`${ORDER_BOOK}/account/${FILL_AGENT}/orders?limit=10`);
    if (r.ok) {
      recent = (await r.json()).map((o) => ({
        uid: o.uid,
        status: o.status,
        created: o.creationDate,
        sell_token: o.sellToken,
        buy_token: o.buyToken,
        sell_amount: o.sellAmount,
        buy_amount: o.buyAmount,
        executed_sell: o.executedSellAmount,
        executed_buy: o.executedBuyAmount,
        valid_to: o.validTo,
      }));
    }
  } catch { /* reported as null */ }
  return {
    what: "Relay that takes the vault's Dutch auction orders to the CoW Protocol order book.",
    how: "Every minute the relay asks ComposableCoW for the order the GblinAuctionOrder generator returns for each auctioned row and posts it. The order is signed by the fill agent through EIP-1271; the relay holds no key. The order book re-verifies the signature and the settlement contract re-checks price and amounts on chain.",
    vault: VAULT,
    fill_agent: FILL_AGENT,
    order_generator: ORDER_GENERATOR,
    composable_cow: COMPOSABLE_COW,
    bucket_seconds: BUCKET_SECONDS,
    rows,
    recent_orders: recent,
    read_at: new Date().toISOString(),
  };
}
