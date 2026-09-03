import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { registerBaggedTools } from "../mcp/tools.js";

/**
 * Hosted MCP server: partners point an MCP client at this one URL (with
 * their existing `x-api-key` header, same as every other route) instead of
 * hand-wiring nine separate HTTP integrations -- see src/mcp/tools.ts for
 * the tool definitions and the full rationale.
 *
 * Auth/rate limiting are NOT this file's job: src/plugins/apiKey.ts and
 * src/plugins/rateLimit.ts are both global (fastify-plugin, registered
 * once in app.ts) and already run for `/mcp` like any other route -- no
 * exemption was added for it, unlike `/admin` and `/partner`.
 *
 * Stateless mode (`sessionIdGenerator: undefined`): a fresh McpServer +
 * transport per request, matching the SDK's own documented pattern for
 * this shape of deployment (Railway currently runs one instance -- see
 * rateLimit.ts's comment on the same in-memory-vs-multi-instance
 * tradeoff). No session store, no session-resumption/cancellation
 * endpoints to build -- GET/DELETE just 405, since there's no session to
 * resume or terminate.
 */
/** Matches the SDK's own examples/server/simpleStatelessStreamableHttp.ts -- /mcp speaks JSON-RPC, not this app's usual `{ error, message }` REST convention, so its error responses follow the SDK's shape instead of src/lib/errors.ts's. */
function jsonRpcMethodNotAllowed(reply: FastifyReply, message: string) {
  reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export default async function mcpRoutes(app: FastifyInstance) {
  app.post("/mcp", async (req, reply) => {
    const server = new McpServer({ name: "bagged", version: "1.0.0" });
    registerBaggedTools(server, app);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      // The transport writes the raw Node response itself (status,
      // headers, SSE or plain-JSON body) -- hijacking tells Fastify not to
      // also try to send one.
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, "error handling MCP request");
      if (!reply.raw.headersSent) {
        reply.hijack();
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });

  app.get("/mcp", async (_req, reply) => {
    jsonRpcMethodNotAllowed(reply, "This MCP server is stateless -- POST only.");
  });

  app.delete("/mcp", async (_req, reply) => {
    jsonRpcMethodNotAllowed(reply, "This MCP server is stateless -- nothing to terminate.");
  });
}
