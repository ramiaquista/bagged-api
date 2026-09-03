import { describe, expect, it } from "vitest";
import {
  createAdminSessionToken,
  hashAdminPassword,
  verifyAdminPassword,
  verifyAdminSessionToken,
} from "../src/lib/adminAuth.js";

describe("hashAdminPassword / verifyAdminPassword (unit)", () => {
  it("round-trips a correct password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash (different salt) each time for the same password", () => {
    const a = hashAdminPassword("same password");
    const b = hashAdminPassword("same password");
    expect(a).not.toBe(b);
    expect(verifyAdminPassword("same password", a)).toBe(true);
    expect(verifyAdminPassword("same password", b)).toBe(true);
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyAdminPassword("anything", "not-a-valid-stored-hash")).toBe(false);
  });
});

describe("createAdminSessionToken / verifyAdminSessionToken (unit)", () => {
  const secret = "test-secret";

  it("accepts a freshly issued token", () => {
    const token = createAdminSessionToken(secret);
    expect(verifyAdminSessionToken(secret, token)).toBe(true);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createAdminSessionToken(secret);
    expect(verifyAdminSessionToken("a different secret", token)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = createAdminSessionToken(secret);
    const [payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ exp: Date.now() + 999_999_999 })).toString(
      "base64url",
    );
    expect(tamperedPayload).not.toBe(payload);
    expect(verifyAdminSessionToken(secret, `${tamperedPayload}.${signature}`)).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = createAdminSessionToken(secret, -1);
    expect(verifyAdminSessionToken(secret, token)).toBe(false);
  });

  it("rejects undefined/empty/malformed tokens", () => {
    expect(verifyAdminSessionToken(secret, undefined)).toBe(false);
    expect(verifyAdminSessionToken(secret, "")).toBe(false);
    expect(verifyAdminSessionToken(secret, "not-a-real-token")).toBe(false);
  });
});
