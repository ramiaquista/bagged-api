/**
 * Internal CLI for issuing/rotating/revoking/listing real per-customer API
 * keys (see src/db/apiKeys.ts and db/schema.sql's `api_keys` table).
 *
 * This is the "at minimum an internal script" option from NEXT_STEPS.md
 * item 5 -- a full self-serve dashboard/endpoint is explicitly out of
 * scope. Run directly against whatever `DATABASE_URL` is configured (see
 * src/config.ts / .env), so point it at production carefully.
 *
 * Usage:
 *   npm run keys:create -- --email owner@example.com --tier builder
 *   npm run keys:rotate -- --id <api_key_id>
 *   npm run keys:revoke -- --id <api_key_id>
 *   npm run keys:list   -- [--email owner@example.com]
 *
 * `create`/`rotate` print the plaintext key exactly once -- it is hashed
 * before it ever touches Postgres (see hashApiKey() in src/db/apiKeys.ts)
 * and cannot be recovered later, so copy it down immediately.
 */
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";
import { TIER_NAMES, type Tier } from "../src/lib/tiers.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[name] = next;
      i += 1;
    } else {
      args[name] = "true";
    }
  }
  return args;
}

function usageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      "Usage:",
      "  npm run keys:create -- --email <owner@email> --tier <free|builder|growth>",
      "  npm run keys:rotate -- --id <api_key_id>",
      "  npm run keys:revoke -- --id <api_key_id>",
      "  npm run keys:list   -- [--email <owner@email>]",
    ].join("\n"),
  );
  process.exit(1);
}

function isTier(value: string | undefined): value is Tier {
  return !!value && (TIER_NAMES as readonly string[]).includes(value);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const pool = createPool();

  try {
    switch (command) {
      case "create": {
        const email = args.email;
        const tier = args.tier;
        if (!email) usageAndExit("--email is required");
        if (!isTier(tier)) usageAndExit(`--tier must be one of ${TIER_NAMES.join(", ")}`);
        const { record, plaintext } = await createApiKey(pool, email, tier);
        console.log(`Created API key ${record.id} for ${record.ownerEmail} (tier: ${record.tier}).`);
        console.log(`Key (shown once -- store it securely, it cannot be retrieved again):`);
        console.log(`  ${plaintext}`);
        break;
      }
      case "rotate": {
        const id = args.id;
        if (!id) usageAndExit("--id is required");
        const { record, plaintext } = await rotateApiKey(pool, id);
        console.log(`Rotated ${id} -> new key ${record.id} for ${record.ownerEmail} (tier: ${record.tier}).`);
        console.log(`New key (shown once -- store it securely, it cannot be retrieved again):`);
        console.log(`  ${plaintext}`);
        break;
      }
      case "revoke": {
        const id = args.id;
        if (!id) usageAndExit("--id is required");
        const revoked = await revokeApiKey(pool, id);
        console.log(revoked ? `Revoked ${id}.` : `${id} was already revoked or doesn't exist.`);
        break;
      }
      case "list": {
        const keys = await listApiKeys(pool, args.email);
        if (keys.length === 0) {
          console.log("No API keys found.");
          break;
        }
        for (const k of keys) {
          const status = k.revokedAt ? `revoked ${k.revokedAt}` : "active";
          console.log(
            `${k.id}  ${k.ownerEmail.padEnd(30)}  ${k.tier.padEnd(10)}  ${status.padEnd(28)}  created ${k.createdAt}  last used ${k.lastUsedAt ?? "never"}`,
          );
        }
        break;
      }
      default:
        usageAndExit(command ? `Unknown command "${command}"` : "A command is required");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
