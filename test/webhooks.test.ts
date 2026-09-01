import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const headers = { "x-api-key": "dev" };

describe("webhooks", () => {
  it("registers and lists a webhook", async () => {
    const app = await buildApp();

    const create = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers,
      payload: { url: "https://example.com/hook", wallet: "abc", chain: "solana" },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const list = await app.inject({ method: "GET", url: "/webhooks", headers });
    expect(list.json().webhooks.some((w: { id: string }) => w.id === id)).toBe(true);

    await app.close();
  });
});
