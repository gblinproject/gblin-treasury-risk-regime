/**
 * GBLIN MCP — prompts.
 *
 * Ready-made workflows built only from this server's own tools. Each one states its rule before the
 * steps, so the decision an agent reaches can be audited afterwards against the rule it was given.
 */

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
}

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: "risk_gate",
    title: "Risk gate before deploying capital",
    description:
      "Read the live on-chain risk regime and decide whether to deploy capital, reduce, or stand down, with the rule stated up front so the decision is auditable.",
    arguments: [
      { name: "action", description: "What you are about to do, e.g. 'buy 500 USDC of ETH'.", required: true },
      { name: "risk_budget", description: "How much you are willing to lose on this action.", required: false },
    ],
  },
  {
    name: "pay_in_gblin",
    title: "Pay in GBLIN with a signature and no ETH",
    description:
      "Prepare a gasless GBLIN payment, sign it with your own wallet, verify it against the chain, and only then hand it on. The private key never leaves the wallet.",
    arguments: [
      { name: "from", description: "Your address: the wallet that will sign.", required: true },
      { name: "to", description: "The recipient's address.", required: true },
      { name: "amount_gblin", description: "Amount in GBLIN shares. Give this or amount_usd.", required: false },
      { name: "amount_usd", description: "Amount in USD, converted at the live NAV. Give this or amount_gblin.", required: false },
    ],
  },
  {
    name: "pay_invoice_just_in_time",
    title: "Pay a USDC invoice from a GBLIN treasury",
    description:
      "When an invoice in USDC arrives and the treasury sits in GBLIN, exit just enough to pay it, checking the cooldown and the gas first.",
    arguments: [
      { name: "usdc_needed", description: "The amount of the invoice in USDC.", required: true },
      { name: "wallet_address", description: "The treasury wallet.", required: true },
    ],
  },
  {
    name: "seal_and_verify",
    title: "Seal an AI action and verify the receipt",
    description:
      "Seal the hashes of an action into the public transparency log, fetch the receipt back, and state plainly what the receipt does and does not prove.",
    arguments: [
      { name: "action", description: "A short public label for what the AI did.", required: true },
      { name: "input_hash", description: "sha256 hex (64 characters) of the input.", required: true },
      { name: "output_hash", description: "sha256 hex of the output.", required: false },
    ],
  },
];

type Args = Record<string, unknown>;

function arg(args: Args, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function message(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function getPrompt(name: string, args: Args = {}): (ReturnType<typeof message> & { description: string }) | null {
  switch (name) {
    case "risk_gate": {
      const budget = arg(args, "risk_budget");
      return {
        description: "Risk gate: regime first, decision second.",
        ...message(
`Before doing this, run the risk gate.

Intended action: ${arg(args, "action", "(unspecified)")}${budget ? `\nRisk budget: ${budget}` : ""}

Rule, decided before looking:
- regime "calm": proceed as planned.
- regime "elevated": proceed at half size or wait.
- regime "crash": stand down and keep the capital defensive.

Steps:
1. Call get_market_risk_regime.
2. State the regime and the severity it reports.
3. Apply the rule above and say which branch you took.
4. If the regime could not be read, say so and do not proceed: an unread regime is not a calm one.`),
      };
    }

    case "pay_in_gblin": {
      const amount = arg(args, "amount_gblin") ? `amount_gblin: ${arg(args, "amount_gblin")}` : `amount_usd: ${arg(args, "amount_usd", "(unspecified)")}`;
      return {
        description: "Gasless GBLIN payment: prepare, sign, verify, then carry.",
        ...message(
`Pay in GBLIN with a signature. The payer needs no ETH.

From: ${arg(args, "from", "(your address)")}
To: ${arg(args, "to", "(recipient)")}
${amount}

Rules:
- The private key stays in the wallet. Never paste it into a tool.
- Do not submit anything the verifier says would not settle.

Steps:
1. Call prepare_gblin_payment with these values. Use method "receive" when paying a known recipient.
2. Sign the returned typed_data with the payer's wallet (eth_signTypedData_v4).
3. Call verify_gblin_authorization with the authorization and the signature.
4. If would_settle is true, hand the calldata to the recipient (method "receive") or the x402 payload to a facilitator (method "transfer"). If it is false, report the failures and stop.
5. If nobody will carry it on chain, prepare again with relay: true, sign both messages, and call relay_gblin_payment. The relay fee is paid in GBLIN, and the payment and the fee settle together or not at all.`),
      };
    }

    case "pay_invoice_just_in_time": {
      return {
        description: "Just-in-time exit from GBLIN to USDC to settle an invoice.",
        ...message(
`An invoice in USDC has arrived and the treasury holds GBLIN.

Invoice: ${arg(args, "usdc_needed", "(unspecified)")} USDC
Wallet: ${arg(args, "wallet_address", "(treasury wallet)")}

Rules:
- Exit only what the invoice needs, not the whole position.
- Do not start the exit inside the redemption cooldown or without gas for three transactions.

Steps:
1. Call analyze_treasury_health for the wallet and read the cooldown and the gas status.
2. If the cooldown is active or the gas is insufficient, say which and stop.
3. Call swap_gblin_to_usdc_jit with the invoice amount and the wallet.
4. Call preview_steps with the returned steps. If it says they would not succeed, report the failing step and its reason, and stop.
5. Send the steps in order from the wallet, each with the gas it carries, and confirm each with get_transaction_status before the next. The exit through the Zap is all or nothing: if a step reverts, report it rather than retrying blindly.`),
      };
    }

    case "seal_and_verify": {
      const output = arg(args, "output_hash");
      return {
        description: "Seal, fetch the receipt, and state its limits.",
        ...message(
`Seal this action into the public transparency log and verify the receipt.

Action: ${arg(args, "action", "(unspecified)")}
Input hash: ${arg(args, "input_hash", "(missing)")}${output ? `\nOutput hash: ${output}` : ""}

Steps:
1. Call seal_action_demo with these values.
2. Call get_receipt with the index it returns, and follow the verification it describes.
3. State what the receipt proves: that these hashes were recorded at this position of an append-only log.
4. State what it does not prove: that the action was correct, or that the hashes describe what the label says.`),
      };
    }

    default:
      return null;
  }
}
