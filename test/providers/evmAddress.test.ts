import { describe, expect, it } from "vitest";
import { isEvmAddress } from "../../src/providers/evmAddress.js";

describe("isEvmAddress", () => {
  it("accepts well-formed 0x addresses", () => {
    expect(isEvmAddress("0xC4a17e29F6b3A1D8E7C6B5A4938271605F4E3D2C")).toBe(true);
    expect(isEvmAddress("0x00000000000000000000000000000000000000ad")).toBe(true);
  });

  it("rejects placeholder/malformed strings used by the existing mock-data test suite", () => {
    expect(isEvmAddress("some-address")).toBe(false);
    expect(isEvmAddress("a")).toBe(false);
    expect(isEvmAddress("7xKXtg2CW87d9qzVwmz3s6ARJ6fLZDpTNVeYQezef9Q2")).toBe(false); // a Solana address
    expect(isEvmAddress("0x123")).toBe(false); // too short
  });
});
