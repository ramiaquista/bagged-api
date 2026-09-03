/**
 * Prints an ADMIN_PASSWORD_HASH value (see src/config.ts /
 * src/lib/adminAuth.ts) for a given plaintext password -- paste the
 * output into Railway's env vars (or a local .env) as
 * ADMIN_PASSWORD_HASH. Never persists anything; this only hashes and
 * prints. Mirrors scripts/manage-api-key.ts's CLI style.
 *
 * Usage:
 *   npm run admin:hash-password -- --password 'a real password'
 */
import { hashAdminPassword } from "../src/lib/adminAuth.js";

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const password = args.password;
  if (!password) {
    console.error("Usage: npm run admin:hash-password -- --password '<a real password>'");
    process.exit(1);
  }

  console.log(hashAdminPassword(password));
}

main();
