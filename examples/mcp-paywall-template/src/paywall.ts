import { z } from 'zod';

/**
 * x402 paywall for MCP tool handlers.
 *
 * The payment travels in the `_payment` tool argument as a base64-encoded x402 payment payload
 * (the same value an HTTP client sends in the `X-PAYMENT` header). Before the wrapped handler runs,
 * the payload is checked by the facilitator (`/verify`) and then settled on-chain (`/settle`).
 * The handler runs only after a successful settlement. Any facilitator error fails closed.
 *
 * Replay protection: settlement consumes the EIP-3009 authorization nonce on-chain, so a payload
 * can be settled once. Payloads seen by this process are also rejected locally before any network
 * call. The local set lives in memory: a deployment with several instances should keep it in a
 * shared store.
 *
 * This is a reference template. Review it, pin the facilitator you trust, and test it with small
 * amounts before using it in production.
 */

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const FACILITATOR = (process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator').replace(/\/$/, '');
const FACILITATOR_TIMEOUT_MS = 15_000;

const PaymentPayloadSchema = z
  .object({
    x402Version: z.number(),
    scheme: z.literal('exact'),
    network: z.literal('base'),
    payload: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export interface PaywallContext {
  payment: PaymentPayload;
  payer: string | null;
  transaction: string | null;
}

const seenPayloads = new Set<string>();

function toAtomicUsdc(price: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(price)) throw new Error(`Invalid USDC price: ${price}`);
  const [whole, frac = ''] = price.split('.');
  return (BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, '0'))).toString();
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

async function callFacilitator(path: '/verify' | '/settle', body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${FACILITATOR}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`facilitator ${path} returned HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Wraps an MCP tool handler with x402 payment verification and settlement.
 * Without a payment, the result describes the payment requirements.
 */
export function requirePayment<T extends Record<string, any>>(
  price: string,
  handler: (args: T, ctx: PaywallContext) => Promise<any>,
  resource = 'mcp://tool'
) {
  const amount = toAtomicUsdc(price);

  return async (args: T & { _payment?: string }) => {
    const recipient = process.env.RECIPIENT_WALLET;
    if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      return errorResult('Server misconfigured: RECIPIENT_WALLET is missing or invalid. Contact the operator.');
    }

    const requirements = {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: amount,
      resource,
      description: `Paid MCP tool call (${price} USDC)`,
      mimeType: 'application/json',
      payTo: recipient,
      maxTimeoutSeconds: 300,
      asset: USDC_BASE,
      extra: { name: 'USD Coin', version: '2' },
    };

    if (!args._payment) {
      return errorResult(
        JSON.stringify({ error: 'payment_required', x402Version: 1, accepts: [requirements], facilitator: FACILITATOR }, null, 2)
      );
    }

    let payment: PaymentPayload;
    try {
      payment = PaymentPayloadSchema.parse(JSON.parse(Buffer.from(args._payment, 'base64').toString('utf-8')));
    } catch {
      return errorResult('Invalid payment payload: expected a base64-encoded x402 payment payload for the exact scheme on Base.');
    }

    if (seenPayloads.has(args._payment)) {
      return errorResult('Payment payload already used.');
    }
    seenPayloads.add(args._payment);

    const body = { x402Version: payment.x402Version, paymentPayload: payment, paymentRequirements: requirements };
    try {
      const verified = await callFacilitator('/verify', body);
      if (verified.isValid !== true) {
        return errorResult(`Payment rejected: ${String(verified.invalidReason ?? 'invalid')}.`);
      }
      const settled = await callFacilitator('/settle', body);
      if (settled.success !== true) {
        return errorResult(`Payment not settled: ${String(settled.errorReason ?? 'unknown reason')}.`);
      }
      return handler(args, {
        payment,
        payer: typeof settled.payer === 'string' ? settled.payer : null,
        transaction: typeof settled.transaction === 'string' ? settled.transaction : null,
      });
    } catch (err) {
      // A network failure says nothing about the payload: allow the client to retry it.
      seenPayloads.delete(args._payment);
      return errorResult(`Payment could not be checked: ${err instanceof Error ? err.message : 'facilitator unavailable'}.`);
    }
  };
}
