import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig ALLOW_DEV_KEY", () => {
  it("defaults to false when unset", () => {
    expect(loadConfig({}).ALLOW_DEV_KEY).toBe(false);
  });

  it("is false for the string \"false\" -- not truthy-string-coerced", () => {
    // Regression test: z.coerce.boolean() would make this true, since
    // Boolean("false") is true. ALLOW_DEV_KEY must be exact-string-matched.
    expect(loadConfig({ ALLOW_DEV_KEY: "false" }).ALLOW_DEV_KEY).toBe(false);
  });

  it("is true only for the exact string \"true\"", () => {
    expect(loadConfig({ ALLOW_DEV_KEY: "true" }).ALLOW_DEV_KEY).toBe(true);
  });

  it("rejects any other value", () => {
    expect(() => loadConfig({ ALLOW_DEV_KEY: "yes" })).toThrow();
  });
});
