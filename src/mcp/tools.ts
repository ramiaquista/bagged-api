import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteWebhook, listWebhooks, registerWebhook } from "../db/webhooks.js";
import { ApiError } from "../lib/errors.js";
import { getProvider } from "../providers/registry.js";
import { getLeaderboard, LeaderboardQuerySchema } from "../routes/leaderboard.js";
import { getPortfolio } from "../routes/portfolio.js";
import { BatchPnlRequestSchema } from "../schemas/pnl.js";
import { ChainSchema } from "../schemas/chain.js";
import { RegisterWebhookSchema } from "../schemas/webhook.js";

/**
 * MCP tool surface for `POST /mcp` (src/routes/mcp.ts) -- one tool per
 * public product endpoint, so a partner's MCP client can call "everything
 * Bagged does" through one connection instead of hand-writing nine
 * separate HTTP integrations.
 *
 * Every tool here calls the exact same function its HTTP-route sibling
 * calls (getProvider(...).getWalletPnl, registerWebhook, getLeaderboard,
 * ...) -- no duplicated business logic, no internal HTTP hop. Input
 * schemas reuse the same zod schemas those routes already validate
 * against (ChainSchema, BatchPnlRequestSchema, RegisterWebhookSchema,
 * LeaderboardQuerySchema) as raw shapes, so there's exactly one definition
 * of each request shape, not a second one drifting alongside it.
 *
 * NOT covered: `WS /wallet/{address}/stream`. MCP tools are single
 * call/response; a persistent WebSocket stream doesn't fit that shape, and
 * a "poll once" tool would misrepresent what the real endpoint does.
 * `/admin/*` and `/partner/*` are account-management surfaces, not part of
 * the product API this exists to expose.
 *
 * Auth/rate-limiting: neither is this file's job. `POST /mcp` is just
 * another Fastify route -- src/plugins/apiKey.ts's global onRequest hook
 * and src/plugins/rateLimit.ts's global preHandler hook already ran before
 * any tool handler below executes, exactly like every other route.
 */

/** Same shape check webhooks.ts / admin.ts use for `:id` params -- see webhooks.ts's comment. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs a tool's business logic and converts the outcome into an MCP
 * `CallToolResult`: success becomes pretty-printed JSON text content, and
 * any thrown error (an `ApiError` from the shared error type the HTTP
 * routes throw, or anything else) becomes `isError: true` content instead
 * of an uncaught exception escaping the tool call. Mirrors app.ts's
 * `setErrorHandler` doing the same ApiError -> client-facing-message
 * mapping for HTTP routes, just for the MCP transport instead.
 */
async function toToolResult(work: Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await work;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const message = err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

const AddressChainShape = {
  address: z.string().min(1).describe("Wallet address on the given chain."),
  chain: ChainSchema.describe("Which chain to look up."),
};

export function registerBaggedTools(server: McpServer, app: FastifyInstance): void {
  server.registerTool(
    "get_wallet_pnl",
    {
      description:
        "Real-time realized/unrealized PnL for one wallet on one chain -- bonding-curve cost basis, wash-trade filtering, and rug resolution applied. Equivalent to GET /wallet/{address}/pnl.",
      inputSchema: AddressChainShape,
    },
    ({ address, chain }) => toToolResult(getProvider(chain).getWalletPnl(address)),
  );

  server.registerTool(
    "get_wallet_positions",
    {
      description:
        "Open positions for one wallet on one chain -- quantity, cost basis, and unrealized PnL per token. Equivalent to GET /wallet/{address}/positions.",
      inputSchema: AddressChainShape,
    },
    ({ address, chain }) =>
      toToolResult(
        getProvider(chain)
          .getWalletPositions(address)
          .then((positions) => ({ wallet: address, chain, positions })),
      ),
  );

  server.registerTool(
    "batch_wallet_pnl",
    {
      description: "PnL for up to 100 wallets (each with its own chain) in one call. Equivalent to POST /wallets/batch.",
      inputSchema: BatchPnlRequestSchema.shape,
    },
    ({ wallets }) =>
      toToolResult(
        Promise.all(wallets.map(({ address, chain }) => getProvider(chain).getWalletPnl(address))).then(
          (results) => ({ results }),
        ),
      ),
  );

  server.registerTool(
    "get_card_pnl",
    {
      description:
        "The public shareable-card variant of get_wallet_pnl -- same PnL numbers, no positions/streaming. Equivalent to GET /card/{address}/pnl (public on the HTTP surface; calling it here still costs your key like every other tool, for one consistent auth story).",
      inputSchema: AddressChainShape,
    },
    ({ address, chain }) => toToolResult(getProvider(chain).getWalletPnl(address)),
  );

  server.registerTool(
    "get_portfolio",
    {
      description:
        "Rolls a user's linked wallets across every chain into one PnL figure. Equivalent to GET /portfolio/{userId}. STATUS: stub -- fixed mock wallets per chain, not real linked-wallet persistence yet.",
      inputSchema: { userId: z.string().min(1).describe("Bagged user id.") },
    },
    ({ userId }) => toToolResult(getPortfolio(userId)),
  );

  server.registerTool(
    "get_leaderboard",
    {
      description:
        "Top wallets by PnL, optionally filtered by chain and time window. Equivalent to GET /leaderboard. STATUS: stub -- returns a fixed mock list regardless of params.",
      inputSchema: LeaderboardQuerySchema.shape,
    },
    (query) => toToolResult(Promise.resolve(getLeaderboard(query))),
  );

  server.registerTool(
    "register_webhook",
    {
      description:
        "Registers a PnL-threshold webhook: Bagged POSTs to `url` when a wallet's PnL crosses `threshold_pct`. Equivalent to POST /webhooks.",
      inputSchema: RegisterWebhookSchema.shape,
    },
    (body) => toToolResult(registerWebhook(app.db, body)),
  );

  server.registerTool(
    "list_webhooks",
    {
      description: "Lists every registered webhook. Equivalent to GET /webhooks.",
      inputSchema: {},
    },
    () => toToolResult(listWebhooks(app.db).then((webhooks) => ({ webhooks }))),
  );

  server.registerTool(
    "delete_webhook",
    {
      description: "Deletes a webhook by id. Equivalent to DELETE /webhooks/{id}.",
      inputSchema: { id: z.string().min(1).describe("Webhook id (uuid).") },
    },
    ({ id }) =>
      toToolResult(
        (async () => {
          // Same pre-check webhooks.ts's HTTP route does: a malformed id is a
          // clean "not found" here rather than a raw DB-level error escaping
          // as a generic tool failure.
          const existed = UUID_RE.test(id) && (await deleteWebhook(app.db, id));
          if (!existed) throw ApiError.notFound("No webhook found with that id");
          return { deleted: true };
        })(),
      ),
  );
}
