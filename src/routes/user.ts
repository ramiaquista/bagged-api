import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { isEmailApproved } from "../db/approvedEmails.js";
import { listDailyRealizedPnl, sumRealizedPnl } from "../db/dailyPnl.js";
import { createUser, findUserByEmailWithHash, findUserById, UserEmailTakenError } from "../db/users.js";
import { countWalletsForUser, linkWallet, listWalletsForUser, unlinkWallet, WalletAlreadyLinkedError } from "../db/userWallets.js";
import { findOrCreateWallet } from "../db/wallets.js";
import { ApiError } from "../lib/errors.js";
import {
  createUserSessionToken,
  hashUserPassword,
  USER_SESSION_COOKIE,
  USER_SESSION_TTL_MS,
  verifyUserPassword,
  verifyUserSessionToken,
} from "../lib/userAuth.js";
import { getProvider, supportsTradeHistory } from "../providers/registry.js";
import { LinkWalletSchema, UserLoginSchema, UserSignupSchema } from "../schemas/user.js";
import { recomputeDailyPnlForWallet } from "../worker/dailyPnlWorker.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireUserSession below for every authenticated /user/* request. */
    userId?: string;
  }
}

/** Cap on how many wallets one consumer account can link -- a guardrail against a runaway client, same role as PARTNER_MAX_ACTIVE_KEYS in src/routes/partner.ts. */
export const USER_MAX_WALLETS = 25;

/** Rate limits for the two unauthenticated /user endpoints -- same reasoning and shape as PARTNER_LOGIN_RATE_LIMIT / PARTNER_SIGNUP_RATE_LIMIT in src/routes/partner.ts. */
export const USER_LOGIN_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;
export const USER_SIGNUP_RATE_LIMIT = { max: 5, timeWindow: "10 minutes" } as const;

const RANGE_DAYS: Record<"7d" | "30d" | "all", number> = { "7d": 7, "30d": 30, all: 365 };
const RangeQuerySchema = z.object({ range: z.enum(["7d", "30d", "all"]).default("30d") });
const MonthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")
    .optional(),
  walletIds: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .optional(),
});
const WalletParamsSchema = z.object({ walletId: z.string().min(1) });

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * Self-serve consumer (B2C) surface backing bagged-website's `/app` --
 * where an individual creates their own account and tracks their linked
 * wallets' PnL: a big personal PnL card and a monthly calendar showing
 * real per-day realized PnL (see src/worker/dailyPnlWorker.ts and
 * db/schema.sql's `daily_realized_pnl` table for why "realized" and not
 * "total" per day -- unrealized has no honest historical value without a
 * price-history source neither provider integration has yet).
 *
 * A third, fully independent auth domain: /admin (one operator, env-
 * configured), /partner (self-serve API customers, /b2b-dashboard), and
 * this one (self-serve individuals, /app) never share a session cookie or
 * a secret -- see src/lib/userAuth.ts's doc comment. /app users also never
 * touch the API-key surface (`api_keys`) at all -- they're tracking their
 * own portfolio inside the product, not calling the API as a developer.
 */
async function requireUserSession(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const path = req.url.split("?")[0];
  if (path === "/user/signup" || path === "/user/login") return;

  const token = req.cookies[USER_SESSION_COOKIE];
  const userId = verifyUserSessionToken(config.USER_SESSION_SECRET, token);
  if (!userId) {
    throw ApiError.unauthorized("Not signed in");
  }
  req.userId = userId;
}

function setUserSessionCookie(reply: FastifyReply, secret: string, userId: string): void {
  const token = createUserSessionToken(secret, userId);
  reply.setCookie(USER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    // Cross-site by design, same as PARTNER_SESSION_COOKIE / ADMIN_SESSION_COOKIE:
    // bagged-website and bagged-api are different sites/domains.
    sameSite: "none",
    path: "/user",
    maxAge: Math.floor(USER_SESSION_TTL_MS / 1000),
  });
}

export default async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUserSession);

  app.post("/user/signup", { config: { rateLimit: USER_SIGNUP_RATE_LIMIT } }, async (req, reply) => {
    const body = UserSignupSchema.parse(req.body);

    // Check if email is approved for signup
    const approved = await isEmailApproved(app.db, body.email.toLowerCase());
    if (!approved) {
      throw ApiError.forbidden("This email address is not approved for signup. Please contact the administrator.");
    }

    const passwordHash = hashUserPassword(body.password);
    let user;
    try {
      user = await createUser(app.db, body.email, passwordHash, body.displayName ?? null);
    } catch (err) {
      if (err instanceof UserEmailTakenError) {
        throw ApiError.badRequest("An account already exists for that email -- try signing in instead.");
      }
      throw err;
    }

    setUserSessionCookie(reply, config.USER_SESSION_SECRET, user.id);
    reply.code(201);
    return { user };
  });

  app.post("/user/login", { config: { rateLimit: USER_LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const { email, password } = UserLoginSchema.parse(req.body);

    const found = await findUserByEmailWithHash(app.db, email);
    // Same anti-enumeration reasoning as routes/partner.ts's login: one
    // error, one code path, regardless of which check actually failed.
    const validPassword = found ? verifyUserPassword(password, found.passwordHash) : false;
    if (!found || !validPassword) {
      throw ApiError.unauthorized("Invalid email or password");
    }

    setUserSessionCookie(reply, config.USER_SESSION_SECRET, found.id);
    return { ok: true };
  });

  app.post("/user/logout", async (_req, reply) => {
    reply.clearCookie(USER_SESSION_COOKIE, { path: "/user", secure: true, sameSite: "none" });
    return { ok: true };
  });

  // Cheap "is my cookie still valid" check for the /app shell's mount-time gate, same role as GET /partner/session.
  app.get("/user/session", async () => ({ authenticated: true }));

  app.get("/user/me", async (req) => {
    const user = await findUserById(app.db, req.userId!);
    if (!user) {
      throw ApiError.unauthorized("Not signed in");
    }
    return { user };
  });

  app.get("/user/wallets", async (req) => {
    const linked = await listWalletsForUser(app.db, req.userId!);
    const wallets = await Promise.all(
      linked.map(async (w) => {
        const pnl = await getProvider(w.chain).getWalletPnl(w.address);
        return {
          walletId: w.walletId,
          chain: w.chain,
          address: w.address,
          label: w.label,
          linkedAt: w.linkedAt,
          realizedPnlUsd: pnl.realized_pnl_usd,
          unrealizedPnlUsd: pnl.unrealized_pnl_usd,
          totalPnlUsd: pnl.total_pnl_usd,
          positionsOpen: pnl.positions_open,
        };
      }),
    );
    return { wallets };
  });

  app.post("/user/wallets", async (req, reply) => {
    const body = LinkWalletSchema.parse(req.body);

    const activeCount = await countWalletsForUser(app.db, req.userId!);
    if (activeCount >= USER_MAX_WALLETS) {
      throw ApiError.badRequest(
        `You already have ${activeCount} wallets linked (max ${USER_MAX_WALLETS}). Unlink one before adding another.`,
      );
    }

    const wallet = await findOrCreateWallet(app.db, body.chain, body.address);
    let link;
    try {
      link = await linkWallet(app.db, req.userId!, wallet.id, body.label ?? null);
    } catch (err) {
      if (err instanceof WalletAlreadyLinkedError) {
        throw ApiError.badRequest("This wallet is already linked to your account.");
      }
      throw err;
    }

    // Best-effort immediate recompute so the calendar isn't empty until the
    // next worker tick (src/worker/dailyPnlWorker.ts) -- a provider hiccup
    // here shouldn't fail the link itself (the timer will pick it up).
    try {
      await recomputeDailyPnlForWallet(app, wallet.id, wallet.chain, wallet.address);
    } catch (err) {
      req.log.warn({ err, walletId: wallet.id }, "initial daily PnL recompute failed after linking wallet");
    }

    reply.code(201);
    return {
      wallet: {
        walletId: wallet.id,
        chain: wallet.chain,
        address: wallet.address,
        label: link.label,
        linkedAt: link.linkedAt,
      },
    };
  });

  app.post("/user/wallets/:walletId/unlink", async (req) => {
    const { walletId } = WalletParamsSchema.parse(req.params);
    const unlinked = await unlinkWallet(app.db, req.userId!, walletId);
    if (!unlinked) {
      throw ApiError.notFound("No linked wallet found with that id");
    }
    return { unlinked: true };
  });

  app.get("/user/wallets/:walletId/trades", async (req) => {
    const { walletId } = WalletParamsSchema.parse(req.params);
    const wallet = await findOrCreateWallet(app.db, "ethereum", "0x0"); // placeholder, will be replaced

    // Verify the wallet belongs to the user
    const linked = await listWalletsForUser(app.db, req.userId!);
    const walletLink = linked.find((w) => w.walletId === walletId);
    if (!walletLink) {
      throw ApiError.notFound("No linked wallet found with that id");
    }

    const provider = getProvider(walletLink.chain);
    if (!supportsTradeHistory(provider)) {
      return { trades: [] }; // Chain doesn't support trade history yet
    }

    const trades = await provider.getWalletTrades(walletLink.address);
    return { trades };
  });

  app.get("/user/portfolio", async (req) => {
    const { range } = RangeQuerySchema.parse(req.query);
    const days = RANGE_DAYS[range];
    const today = todayUtc();
    const fromDay = toDayString(addDaysUtc(today, -(days - 1)));
    const toDay = toDayString(today);

    const linked = await listWalletsForUser(app.db, req.userId!);
    const walletIds = linked.map((w) => w.walletId);

    const [realizedPnlUsd, series, livePerWallet] = await Promise.all([
      sumRealizedPnl(app.db, walletIds, fromDay, toDay),
      listDailyRealizedPnl(app.db, walletIds, fromDay, toDay),
      Promise.all(linked.map((w) => getProvider(w.chain).getWalletPnl(w.address))),
    ]);

    const unrealizedPnlUsd = livePerWallet.reduce((sum, p) => sum + p.unrealized_pnl_usd, 0);
    const positionsOpen = livePerWallet.reduce((sum, p) => sum + p.positions_open, 0);

    // Cumulative real realized-PnL series across the range, for the hero
    // card's sparkline -- built from the same rows `series` returns above,
    // not fabricated client-side. Days with no row across any wallet
    // contribute 0 to the running total (not "unknown") -- a sparkline is
    // a shape, not a per-point audit trail like the calendar below.
    const byDay = new Map<string, number>();
    for (const row of series) {
      byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.realizedPnlUsd);
    }
    let cumulative = 0;
    const sparkline: { date: string; cumulativeRealizedPnlUsd: number }[] = [];
    for (let d = new Date(fromDay + "T00:00:00.000Z"); toDayString(d) <= toDay; d = addDaysUtc(d, 1)) {
      const dateStr = toDayString(d);
      cumulative += byDay.get(dateStr) ?? 0;
      sparkline.push({ date: dateStr, cumulativeRealizedPnlUsd: Math.round(cumulative * 100) / 100 });
    }

    // Win rate over the trailing 30 real-trading calendar days actually
    // recorded (not 30 calendar days regardless of coverage) -- a wallet
    // linked 3 days ago shouldn't show a mostly-"no data" 30-day rate.
    const trailing30From = toDayString(addDaysUtc(today, -29));
    const trailing30 = await listDailyRealizedPnl(app.db, walletIds, trailing30From, toDay);
    const trailing30ByDay = new Map<string, number>();
    for (const row of trailing30) {
      trailing30ByDay.set(row.day, (trailing30ByDay.get(row.day) ?? 0) + row.realizedPnlUsd);
    }
    const trackedDays = trailing30ByDay.size;
    const winDays = [...trailing30ByDay.values()].filter((v) => v > 0).length;
    const winRate30d = trackedDays > 0 ? Math.round((winDays / trackedDays) * 100) : null;

    const primaryWallet = linked[0] ?? null;

    return {
      range,
      realizedPnlUsd: Math.round(realizedPnlUsd * 100) / 100,
      unrealizedPnlUsd: Math.round(unrealizedPnlUsd * 100) / 100,
      totalPnlUsd: Math.round((realizedPnlUsd + unrealizedPnlUsd) * 100) / 100,
      positionsOpen,
      linkedWallets: linked.length,
      winRate30d,
      primaryWallet: primaryWallet ? { chain: primaryWallet.chain, address: primaryWallet.address } : null,
      wallets: linked.map((w) => ({ walletId: w.walletId, chain: w.chain, address: w.address })),
      sparkline,
    };
  });

  app.get("/user/calendar", async (req) => {
    const { month, walletIds: walletIdsParam } = MonthQuerySchema.parse(req.query);
    const today = todayUtc();
    const [year, monthNum] = month
      ? month.split("-").map((n) => Number(n))
      : [today.getUTCFullYear(), today.getUTCMonth() + 1];
    const monthStart = new Date(Date.UTC(year!, monthNum! - 1, 1));
    const monthEnd = new Date(Date.UTC(year!, monthNum!, 0)); // last day of the month

    const linked = await listWalletsForUser(app.db, req.userId!);

    // Filter to selected wallets if provided, otherwise use all wallets
    let walletIds: string[];
    if (walletIdsParam && walletIdsParam.length > 0) {
      const selectedIds = Array.isArray(walletIdsParam) ? walletIdsParam : [walletIdsParam];
      walletIds = linked
        .filter((w) => selectedIds.includes(w.walletId))
        .map((w) => w.walletId);
    } else {
      walletIds = linked.map((w) => w.walletId);
    }

    const rows = await listDailyRealizedPnl(app.db, walletIds, toDayString(monthStart), toDayString(monthEnd));

    const byDay = new Map<string, { realizedPnlUsd: number; tradeCount: number }>();
    for (const row of rows) {
      const existing = byDay.get(row.day);
      if (existing) {
        existing.realizedPnlUsd += row.realizedPnlUsd;
        existing.tradeCount += row.tradeCount;
      } else {
        byDay.set(row.day, { realizedPnlUsd: row.realizedPnlUsd, tradeCount: row.tradeCount });
      }
    }

    const daysInMonth = monthEnd.getUTCDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const date = toDayString(new Date(Date.UTC(year!, monthNum! - 1, i + 1)));
      const found = byDay.get(date);
      return {
        date,
        realizedPnlUsd: found ? Math.round(found.realizedPnlUsd * 100) / 100 : 0,
        tradeCount: found?.tradeCount ?? 0,
        // A day genuinely has real data only once the worker has computed
        // and stored at least one row reaching back to it (see
        // db/dailyPnl.ts's replaceDailyRealizedPnl doc comment) -- absence
        // of a row means "not indexed / not computed yet", not "$0", and
        // the frontend renders those two states differently.
        tracked: Boolean(found),
      };
    });

    return { month: `${year}-${String(monthNum).padStart(2, "0")}`, days };
  });
}
