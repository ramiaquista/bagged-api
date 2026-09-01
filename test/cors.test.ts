import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { isOriginAllowed, parseExtraAllowedOrigins } from "../src/lib/cors.js";

describe("isOriginAllowed (unit)", () => {
  const noExtras = new Set<string>();

  it("allows the production marketing site", () => {
    expect(isOriginAllowed("https://bagged.life", noExtras)).toBe(true);
  });

  it("allows the www alias", () => {
    expect(isOriginAllowed("https://www.bagged.life", noExtras)).toBe(true);
  });

  it("allows Vercel preview deploys of bagged-website", () => {
    expect(isOriginAllowed("https://bagged-website-abc123.vercel.app", noExtras)).toBe(true);
    expect(
      isOriginAllowed("https://bagged-website-git-feature-x-team.vercel.app", noExtras),
    ).toBe(true);
  });

  it("allows requests with no Origin header (non-browser callers)", () => {
    expect(isOriginAllowed(undefined, noExtras)).toBe(true);
  });

  it("rejects an unrelated origin", () => {
    expect(isOriginAllowed("https://evil.example.com", noExtras)).toBe(false);
  });

  it("rejects a look-alike vercel.app domain that isn't bagged-website", () => {
    expect(isOriginAllowed("https://some-other-app.vercel.app", noExtras)).toBe(false);
  });

  it("rejects a bagged.life subdomain that isn't www", () => {
    expect(isOriginAllowed("https://evil.bagged.life", noExtras)).toBe(false);
  });

  it("rejects http (non-TLS) even for an otherwise-allowed host", () => {
    expect(isOriginAllowed("http://bagged.life", noExtras)).toBe(false);
  });

  it("allows an origin from the extra allow-list", () => {
    const extras = parseExtraAllowedOrigins("https://staging.bagged.life");
    expect(isOriginAllowed("https://staging.bagged.life", extras)).toBe(true);
    expect(isOriginAllowed("https://not-in-list.example.com", extras)).toBe(false);
  });
});

describe("parseExtraAllowedOrigins (unit)", () => {
  it("returns an empty set when unset", () => {
    expect(parseExtraAllowedOrigins(undefined)).toEqual(new Set());
  });

  it("splits comma-separated origins and trims whitespace", () => {
    expect(
      parseExtraAllowedOrigins(" https://a.example.com , https://b.example.com "),
    ).toEqual(new Set(["https://a.example.com", "https://b.example.com"]));
  });

  it("drops blank entries", () => {
    expect(parseExtraAllowedOrigins("https://a.example.com,,")).toEqual(
      new Set(["https://a.example.com"]),
    );
  });
});

describe("CORS headers (integration)", () => {
  it("reflects an allowed origin in Access-Control-Allow-Origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://bagged.life" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://bagged.life");
    await app.close();
  });

  it("reflects an allowed Vercel preview origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://bagged-website-pr-42.vercel.app" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://bagged-website-pr-42.vercel.app",
    );
    await app.close();
  });

  it("does not reflect a disallowed origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
