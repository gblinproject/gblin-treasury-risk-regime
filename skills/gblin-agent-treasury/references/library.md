# Use from TypeScript

```bash
npm install @gblin-protocol/agent-treasury
```

```ts
import { createTreasury, createTreasuryFetch, fromPrivateKey } from "@gblin-protocol/agent-treasury";

const treasury = createTreasury({
  signer: fromPrivateKey(process.env.GBLIN_AGENT_PRIVATE_KEY as `0x${string}`),
  policy: { reserveUsdc: 10, maxPayUsdc: 1 },
});
await treasury.park();
const paidFetch = createTreasuryFetch(treasury);
const res = await paidFetch("https://gblin.digital/api/x402/attestation");
```

`TreasurySigner` is two operations, `sendTransaction({to, data, value, gas?})` and `signTypedData({domain, types, primaryType, message})`, plus `address`: a viem local account fits through `fromAccount`, and a wallet provider that exposes the same two operations (for example an AgentKit EVM wallet provider) can be adapted in a few lines.

`createX402Client(treasury)` returns the configured `x402Client` for other transports; `planExitToUsdc` and `planMintFromUsdc` return the unsigned steps without sending them.
