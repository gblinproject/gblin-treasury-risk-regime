#!/usr/bin/env node
/**
 * gblin-init: add the GBLIN treasury policy to the AGENTS.md of the current repository.
 *
 * Usage:
 *   npx -p @gblin-protocol/mcp-server gblin-init
 *   npx -p @gblin-protocol/mcp-server gblin-init --dry-run
 *   npx -p @gblin-protocol/mcp-server gblin-init --force
 *
 * Behaviour:
 *   - The policy text is bundled in this package and versioned with it. Nothing is downloaded,
 *     so the instructions written into the repository are exactly the ones in the published
 *     release that was installed.
 *   - If ./AGENTS.md does not exist, it is created with the GBLIN block.
 *   - If ./AGENTS.md already contains the GBLIN block (detected by a stable HTML marker),
 *     nothing changes unless --force is given.
 *   - Otherwise a clearly delimited GBLIN block is appended; the existing content is never modified.
 *   - --dry-run prints the block and what would change, without writing.
 *
 * Safety:
 *   - Writes only the file AGENTS.md inside process.cwd().
 *   - Refuses to run inside this package's own directory.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_URL = "https://gblin.digital/agents";

// Stable markers used to detect a previous install and to delimit the block inside an existing
// AGENTS.md. HTML comments survive every Markdown renderer.
const MARKER_BEGIN = "<!-- gblin:agents-md:begin v1 -->";
const MARKER_END = "<!-- gblin:agents-md:end v1 -->";

/** The policy block, bundled with the package. */
export const POLICY_BLOCK = `# AGENTS.md: GBLIN treasury policy

This project runs, or interoperates with, an agent on **Base mainnet (chain id 8453)**. GBLIN is
an on-chain basket of cbBTC, WETH and USDC, minted and redeemed at NAV. Its value follows cbBTC and
WETH, up and down, and it carries no yield. It is **not** a substitute for USDC: operating cash for
upcoming payments stays in USDC.

## Human confirmation

Every GBLIN tool that prepares an operation returns **unsigned** calldata. Nothing is sent without
a signature from the user's wallet. An assistant reading this file must:

- present any mint, redemption or swap to the user, with the amounts and the minimum outputs, and
  wait for explicit confirmation before asking for a signature;
- simulate the steps first with \`preview_steps\`;
- never treat the suggestions below as standing permission to move funds.

## Suggested checks (each one needs the user's confirmation)

\`\`\`
if usdc_balance > 7 * daily_burn_usd and no x402 invoice is pending:
    call plan_treasury, show the plan, and ask whether to park part of the surplus

if an x402 invoice arrives and usdc_balance < invoice_amount:
    call swap_gblin_to_usdc_jit, show the steps, and ask before signing
\`\`\`

## Install

\`\`\`json
{
  "mcpServers": {
    "gblin": {
      "command": "npx",
      "args": ["-y", "@gblin-protocol/mcp-server"]
    }
  }
}
\`\`\`

## Tools

| Tool | Purpose |
| --- | --- |
| \`get_market_risk_regime\` | BTC/ETH risk regime (calm, elevated, crash) read from the vault's Crash Shield |
| \`get_treasury_state\` | NAV, basket weights and Crash Shield status |
| \`plan_treasury\` | Idle USDC to a reviewable plan with live fees and the cost of exiting; reads only |
| \`quote_safe_swap\` | Preview a mint or a redemption with a minimum output |
| \`invest_usdc_to_gblin\` | Unsigned calldata to mint GBLIN with USDC |
| \`swap_gblin_to_usdc_jit\` | Unsigned calldata to turn GBLIN into a given amount of USDC |
| \`preview_steps\` | Simulate the steps against the latest block before signing |
| \`analyze_treasury_health\` | Balances, gas runway and cooldown of a wallet |
| \`get_governance_state\` | Owner, timelock roles and scheduled operations |
| \`get_auction_state\` | The rebalancing auction, row by row |
| \`verify_risk_attestation\` | Verify a Risk Attestation offline |

Documentation: <${DOCS_URL}>
`;

interface ParsedArgs {
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "gblin-init: add the GBLIN treasury policy to AGENTS.md in the current repository",
      "",
      "Usage:",
      "  npx -p @gblin-protocol/mcp-server gblin-init [options]",
      "",
      "Options:",
      "  --dry-run   Print the block and what would change, without writing",
      "  --force     Re-write the GBLIN block even if already present",
      "  --help, -h  Show this help",
      "",
      `Documentation: ${DOCS_URL}`,
    ].join("\n")
  );
}

function isInsideOwnPackage(cwd: string): boolean {
  // dist/init.js is shipped, so __dirname at runtime is something like
  // <pkg>/dist. Walk up one level and compare with cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, "..");
  return resolve(cwd) === pkgRoot;
}

interface RunResult {
  action: "created" | "appended" | "replaced" | "noop";
  path: string;
  message: string;
}

function buildBlock(template: string): string {
  return [
    MARKER_BEGIN,
    "",
    "<!--",
    "  This block was added by `gblin-init` from @gblin-protocol/mcp-server.",
    "  Re-run `npx -p @gblin-protocol/mcp-server gblin-init --force` to refresh it.",
    "-->",
    "",
    template.trim(),
    "",
    MARKER_END,
  ].join("\n");
}

function plan(
  existing: string | null,
  template: string,
  force: boolean
): { result: RunResult; nextContent: string | null } {
  const block = buildBlock(template);
  const targetPath = resolve(process.cwd(), "AGENTS.md");

  if (existing === null) {
    return {
      result: {
        action: "created",
        path: targetPath,
        message: "Created AGENTS.md with the GBLIN treasury policy.",
      },
      nextContent: `${block}\n`,
    };
  }

  const hasMarker = existing.includes(MARKER_BEGIN);
  if (hasMarker && !force) {
    return {
      result: {
        action: "noop",
        path: targetPath,
        message: "AGENTS.md already contains the GBLIN block: nothing to do.",
      },
      nextContent: null,
    };
  }

  if (hasMarker && force) {
    const beginIdx = existing.indexOf(MARKER_BEGIN);
    const endIdx = existing.indexOf(MARKER_END);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
      // Corrupt markers: fall back to append
      return {
        result: {
          action: "appended",
          path: targetPath,
          message:
            "Existing GBLIN markers were malformed; appended a fresh block at the end.",
        },
        nextContent: `${existing.replace(/\s*$/, "")}\n\n${block}\n`,
      };
    }
    const before = existing.slice(0, beginIdx).replace(/\s*$/, "");
    const after = existing.slice(endIdx + MARKER_END.length).replace(/^\s*/, "");
    const next = [before, block, after].filter(Boolean).join("\n\n");
    return {
      result: {
        action: "replaced",
        path: targetPath,
        message: "Refreshed the GBLIN block in your existing AGENTS.md.",
      },
      nextContent: `${next.replace(/\s*$/, "")}\n`,
    };
  }

  // No marker, just append.
  const next = `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
  return {
    result: {
      action: "appended",
      path: targetPath,
      message: "Appended the GBLIN treasury policy block to your AGENTS.md.",
    },
    nextContent: next,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();

  if (isInsideOwnPackage(cwd)) {
    // eslint-disable-next-line no-console
    console.error(
      "[gblin-init] refusing to run inside @gblin-protocol/mcp-server itself."
    );
    process.exitCode = 1;
    return;
  }

  if (basename(cwd) === "node_modules" || cwd.includes(`${"node_modules"}`)) {
    // Common when invoked via `npm exec` from a strange context.
    // We allow it but warn: the user might not want to write here.
    // eslint-disable-next-line no-console
    console.warn(
      `[gblin-init] current directory looks like an install path: ${cwd}`
    );
  }

  const targetPath = resolve(cwd, "AGENTS.md");
  const existing = existsSync(targetPath)
    ? readFileSync(targetPath, "utf8")
    : null;

  const { result, nextContent } = plan(existing, POLICY_BLOCK, args.force);

  if (args.dryRun) {
    const verbs: Record<RunResult["action"], string> = {
      created: "create",
      appended: "append to",
      replaced: "refresh",
      noop: "leave",
    };
    // eslint-disable-next-line no-console
    console.log(
      `[gblin-init] dry run: would ${verbs[result.action]}: ${targetPath}`
    );
    // eslint-disable-next-line no-console
    console.log(`[gblin-init] ${result.message}`);
    if (nextContent !== null) {
      // eslint-disable-next-line no-console
      console.log(`\n${buildBlock(POLICY_BLOCK)}`);
    }
    return;
  }

  if (nextContent !== null) {
    writeFileSync(targetPath, nextContent, "utf8");
  }

  // eslint-disable-next-line no-console
  console.log(`[gblin-init] ${result.message}`);
  // eslint-disable-next-line no-console
  console.log(`[gblin-init] file: ${result.path}`);
  if (result.action !== "noop") {
    // eslint-disable-next-line no-console
    console.log(
      "[gblin-init] coding assistants that read AGENTS.md will load it in their next session."
    );
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[gblin-init] fatal:", (err as Error).message);
  process.exitCode = 1;
});
