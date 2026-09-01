import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";

/**
 * Stand-in data so the API surface is fully exercisable before real chain
 * indexing (Helius/Alchemy/Jupiter) is wired in. Numbers intentionally match
 * the demo shown on the marketing site for a consistent story end-to-end.
 */

type MockPnl = Omit<WalletPnl, "wallet" | "chain" | "as_of">;

export const MOCK_WALLETS: Record<Chain, string> = {
  solana: "7xKXtg2CW87d9qzVwmz3s6ARJ6fLZDpTNVeYQezef9Q2",
  bnb: "0x8f3aA61e6b7A4B4D3D0F5c8E1a9B7C6D5E4F3A2B",
  robinhood: "0xC4a17e29F6b3A1D8E7C6B5A4938271605F4E3D2C",
  ethereum: "0x1B92aC48D9E7F6C5B4A3928170F6E5D4C3B2A19E",
};

const MOCK_PNL: Record<Chain, MockPnl> = {
  solana: {
    realized_pnl_usd: 98432.11,
    unrealized_pnl_usd: 15776.31,
    total_pnl_usd: 114208.42,
    positions_open: 12,
    wash_trades_excluded: 4,
    rugs_resolved: 2,
  },
  bnb: {
    realized_pnl_usd: 30000.0,
    unrealized_pnl_usd: 12910.18,
    total_pnl_usd: 42910.18,
    positions_open: 7,
    wash_trades_excluded: 2,
    rugs_resolved: 1,
  },
  robinhood: {
    realized_pnl_usd: 5000.0,
    unrealized_pnl_usd: 3340.55,
    total_pnl_usd: 8340.55,
    positions_open: 3,
    wash_trades_excluded: 1,
    rugs_resolved: 0,
  },
  ethereum: {
    realized_pnl_usd: 20000.0,
    unrealized_pnl_usd: 6775.9,
    total_pnl_usd: 26775.9,
    positions_open: 5,
    wash_trades_excluded: 3,
    rugs_resolved: 1,
  },
};

const MOCK_POSITIONS: Record<Chain, Position[]> = {
  solana: [
    { token: "FLOKAI", mint_or_address: "MockMint1FLOKAI11111111111111111111111111", quantity: 128000, value_usd: 8204.11, cost_basis_usd: 900.5, unrealized_pnl_usd: 7303.61, unrealized_pnl_pct: 811.1 },
    { token: "CHAD", mint_or_address: "MockMint2CHAD111111111111111111111111111", quantity: 54000, value_usd: 3110.4, cost_basis_usd: 1295.2, unrealized_pnl_usd: 1815.2, unrealized_pnl_pct: 140.1 },
    { token: "BAGZ", mint_or_address: "MockMint3BAGZ111111111111111111111111111", quantity: 9800, value_usd: 960.0, cost_basis_usd: 1230.8, unrealized_pnl_usd: -270.8, unrealized_pnl_pct: -22.0 },
  ],
  bnb: [
    { token: "MOONK", mint_or_address: "0xMockBnbTokenMoonk00000000000000000001", quantity: 210000, value_usd: 9410.0, cost_basis_usd: 4100.0, unrealized_pnl_usd: 5310.0, unrealized_pnl_pct: 129.5 },
    { token: "WHTBULL", mint_or_address: "0xMockBnbTokenWhtbull0000000000000000002", quantity: 15000, value_usd: 3500.18, cost_basis_usd: 4590.0, unrealized_pnl_usd: -1089.82, unrealized_pnl_pct: -23.7 },
  ],
  robinhood: [
    { token: "CASHCO", mint_or_address: "0xMockRobinTokenCashco000000000000000003", quantity: 4200, value_usd: 3340.55, cost_basis_usd: 2035.0, unrealized_pnl_usd: 1305.55, unrealized_pnl_pct: 64.2 },
  ],
  ethereum: [
    { token: "PEPU", mint_or_address: "0xMockEthTokenPepu00000000000000000000004", quantity: 61000, value_usd: 6775.9, cost_basis_usd: 5100.0, unrealized_pnl_usd: 1675.9, unrealized_pnl_pct: 32.9 },
  ],
};

export function mockPnlFor(chain: Chain, wallet: string): WalletPnl {
  return {
    wallet,
    chain,
    as_of: new Date().toISOString(),
    ...MOCK_PNL[chain],
  };
}

export function mockPositionsFor(chain: Chain): Position[] {
  return MOCK_POSITIONS[chain];
}
