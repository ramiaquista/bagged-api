import { describe, expect, it } from "vitest";
import { ethereumResolver } from "../../src/providers/launchpads/ethereum.js";
import { fourMemeResolver } from "../../src/providers/launchpads/fourMeme.js";
import { hoodFunResolver } from "../../src/providers/launchpads/hoodFun.js";
import { getLaunchpadResolver } from "../../src/providers/launchpads/registry.js";

describe("launchpad resolvers", () => {
  it("four.meme recognizes the BNB TokenManager2 proxy, case-insensitively", () => {
    expect(fourMemeResolver.isBondingCurveAddress("0x5c952063c7fc8610FFDB798152D69F0B9550762b")).toBe(true);
    expect(fourMemeResolver.isBondingCurveAddress("0x5c952063c7fc8610ffdb798152d69f0b9550762b")).toBe(true);
    expect(fourMemeResolver.isBondingCurveAddress("0x00000000000000000000000000000000000000ad")).toBe(false);
  });

  it("hood.fun has no confirmed contract addresses yet (documented research gap)", () => {
    expect(hoodFunResolver.isBondingCurveAddress("0x5c952063c7fc8610ffdb798152d69f0b9550762b")).toBe(false);
  });

  it("ethereum resolver never tags a bonding-curve fill (no dominant launchpad)", () => {
    expect(ethereumResolver.isBondingCurveAddress("0x5c952063c7fc8610ffdb798152d69f0b9550762b")).toBe(false);
  });

  it("registry maps each chain to its own resolver", () => {
    expect(getLaunchpadResolver("bnb")).toBe(fourMemeResolver);
    expect(getLaunchpadResolver("robinhood")).toBe(hoodFunResolver);
    expect(getLaunchpadResolver("ethereum")).toBe(ethereumResolver);
  });
});
