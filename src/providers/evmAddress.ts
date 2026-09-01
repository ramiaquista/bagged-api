/**
 * Minimal EVM address format check (0x + 40 hex chars). Does not verify
 * EIP-55 checksum casing -- callers here only need to decide "is this
 * plausibly a real on-chain address worth an Alchemy call, or a
 * placeholder/test string" (see EvmProvider), not full validation.
 */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
