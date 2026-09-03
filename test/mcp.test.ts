import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { createApiKey } from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";
import { registerWebhook } from "../src/db/webhooks.js";

// Real integration tests against Postgres, matching test/admin.test.ts's and
// test/webhooks.test.ts's pattern -- truncates the same table set
// (api_key_usage/api_keys for the real per-customer key this file mints,
// wallets cascade for the webhook tools).
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table api_key_usage, api_keys cascade");
  await pool.query("truncate table wallets cascade");
});

afterAll(async () => {
  await pool.end();
});

/**
 * `/mcp` responds over Streamable HTTP, not plain JSON -- a successful
 * POST comes back as an SSE-framed body (`event: message\ndata: {...}\n\n`),
 * not a bare JSON document. This unwraps the one `data:` line's JSON-RPC
 * envelope, the same shape every other test file gets straight from
 * `res.json()`.
 */
function jsonRpcResult(res: LightMyRequestResponse): { result?: unknown; error?: { message: string } } {
  const dataLine = res.body.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no SSE data line in MCP response: ${res.body}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function callTool(
  app: Awaited<ReturnType<typeof buildApp>>,
  apiKey: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return { res, body: jsonRpcResult(res) };
}

describe("POST /mcp", () => {
  it("rejects requests with no x-api-key, same as every other route", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET and DELETE are 405 -- this server is stateless, nothing to resume or terminate", async () => {
    const app = await buildApp();
    const headers = { "x-api-key": "dev" };
    const get = await app.inject({ method: "GET", url: "/mcp", headers });
    const del = await app.inject({ method: "DELETE", url: "/mcp", headers });
    expect(get.statusCode).toBe(405);
    expect(del.statusCode).toBe(405);
    await app.close();
  });

  it("tools/list returns all nine product-endpoint tools", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-api-key": "dev", "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(200);
    const { result } = jsonRpcResult(res) as { result: { tools: Array<{ name: string }> } };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "batch_wallet_pnl",
        "delete_webhook",
        "get_card_pnl",
        "get_leaderboard",
        "get_portfolio",
        "get_wallet_pnl",
        "get_wallet_positions",
        "list_webhooks",
        "register_webhook",
      ].sort(),
    );
    await app.close();
  });

  it("get_wallet_pnl round-trips real provider data, authenticated with a real per-customer key", async () => {
    const app = await buildApp();
    const { plaintext } = await createApiKey(pool, "mcp-test@example.com", "free");

    const { res, body } = await callTool(app, plaintext, "get_wallet_pnl", {
      address: "some-address",
      chain: "solana",
    });
    expect(res.statusCode).toBe(200);
    const result = body.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const pnl = JSON.parse(result.content[0]!.text);
    expect(pnl).toMatchObject({ wallet: "some-address", chain: "solana" });

    await app.close();
  });

  it("register_webhook then list_webhooks reflects it back, via the same DB rows the HTTP routes use", async () => {
    const app = await buildApp();

    const registered = await callTool(app, "dev", "register_webhook", {
      url: "https://example.com/hook",
      wallet: "mcp-wallet",
      chain: "solana",
      threshold_pct: 15,
    });
    const registeredResult = registered.body.result as { content: Array<{ text: string }> };
    const record = JSON.parse(registeredResult.content[0]!.text);
    expect(record).toMatchObject({ url: "https://example.com/hook", wallet: "mcp-wallet", chain: "solana" });

    const listed = await callTool(app, "dev", "list_webhooks");
    const listedResult = listed.body.result as { content: Array<{ text: string }> };
    const { webhooks } = JSON.parse(listedResult.content[0]!.text);
    expect(webhooks).toEqual(expect.arrayContaining([expect.objectContaining({ id: record.id })]));

    await app.close();
  });

  it("delete_webhook on a malformed id comes back as isError, not an uncaught 500", async () => {
    const app = await buildApp();
    const { res, body } = await callTool(app, "dev", "delete_webhook", { id: "not-a-uuid" });
    expect(res.statusCode).toBe(200);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no webhook found/i);
    await app.close();
  });

  it("delete_webhook actually deletes a real one, mirroring DELETE /webhooks/:id", async () => {
    const app = await buildApp();
    const record = await registerWebhook(pool, {
      url: "https://example.com/hook",
      wallet: "mcp-delete-wallet",
      chain: "solana",
      threshold_pct: 10,
    });

    const { body } = await callTool(app, "dev", "delete_webhook", { id: record.id });
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ deleted: true });

    const listed = await callTool(app, "dev", "list_webhooks");
    const listedResult = listed.body.result as { content: Array<{ text: string }> };
    const { webhooks } = JSON.parse(listedResult.content[0]!.text);
    expect(webhooks.find((w: { id: string }) => w.id === record.id)).toBeUndefined();

    await app.close();
  });
});
