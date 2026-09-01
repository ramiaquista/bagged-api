import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("waitlist", () => {
  it("accepts a signup without an x-api-key header", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "trader@example.com" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("is idempotent for a repeat signup", async () => {
    const app = await buildApp();
    const payload = { email: "repeat@example.com" };

    const first = await app.inject({ method: "POST", url: "/waitlist", payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: "POST", url: "/waitlist", payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "already_registered" });

    await app.close();
  });

  it("normalizes case before dedup", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "Mixed@Example.com" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "mixed@example.com" },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "already_registered" });

    await app.close();
  });

  it("rejects an invalid email", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "not-an-email" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("keeps /waitlist/count behind the standard x-api-key check", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/waitlist/count" });
    expect(res.statusCode).toBe(401);

    const withKey = await app.inject({
      method: "GET",
      url: "/waitlist/count",
      headers: { "x-api-key": "dev" },
    });
    expect(withKey.statusCode).toBe(200);
    expect(withKey.json()).toEqual({ count: expect.any(Number) });

    await app.close();
  });
});
