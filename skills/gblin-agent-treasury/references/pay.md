# Pay an x402 endpoint from the treasury

```bash
npx @gblin-protocol/agent-treasury@0.1.1 pay <url> [-X <method>] [-d <json>] [--max-amount <atomic USDC>] [--json]
```

The request is sent; on a 402 the client (Coinbase's reference `x402Client`, EVM "exact" scheme) reads the price. If the wallet's USDC is short, the shortfall is refilled from GBLIN **before** the authorization is signed; if the price is above the cap, the payment is refused **before** anything is signed. Then the paid request is retried with the signed authorization; `paymentResponse` in the output is the settlement header.

## Options

| Option | Meaning |
| --- | --- |
| `-X, --method` | HTTP method (default GET) |
| `-d, --data` | JSON body (single-quoted) |
| `--max-amount` | cap for this call in atomic USDC units (`1000000` = 1 USDC); the policy cap applies otherwise |
| `--json` | machine-readable output |

## Input validation

- `<url>` must start with `https://` or `http://` and contain no spaces, `;`, `|`, backticks or `$`.
- `-d` must be valid JSON; wrap it in single quotes.
- `--max-amount` must match `^\d+$`.

## Example

```bash
npx @gblin-protocol/agent-treasury@0.1.1 pay https://gblin.digital/api/x402/attestation --max-amount 3000 --json
```

Pays 0.003 USDC for a signed market-risk attestation (regime, severity, expiry), refilling USDC from GBLIN first if needed.

## Errors

- `above the treasury cap`: raise `--max-amount` only on the user's instruction.
- `Could not make … USDC available`: see `ensure-usdc.md` for the underlying reason (cooldown, cap, no GBLIN).
- A non-402 error from the endpoint is returned as is with its status code.
