import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db/pool.js";
import { USER_SESSION_COOKIE } from "../src/lib/userAuth.js";
import { USER_MAX_WALLETS } from "../src/routes/user.js";

// Real integration tests against Postgres, matching test/partner.test.ts's
// pattern. `truncate table users cascade` sweeps user_wallets too (see
// db/schema.sql). `wallets`/`daily_realized_pnl` rows are left alone --
// every test here uses a unique wallet address, so nothing collides.
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table users cascade");
});

afterAll(async () => {
  await pool.end();
});

const SIGNUP_BODY = { email: "trader@example.com", password: "correct-horse-battery" };

/** Signs up a fresh user and returns cookies for app.inject() plus the response body. */
async function signup(app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown> = SIGNUP_BODY) {
  const res = await app.inject({ method: "POST", url: "/user/signup", payload: body });
  const cookie = res.cookies.find((c) => c.name === USER_SESSION_COOKIE);
  if (res.statusCode !== 201 || !cookie) {
    throw new Error(`signup did not succeed (status ${res.statusCode}): ${res.body}`);
  }
  return { cookies: { [USER_SESSION_COOKIE]: cookie.value }, body: res.json() };
}

describe("user signup", () => {
  it("creates an account and signs the caller in, with no API key issued", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/user/signup", payload: SIGNUP_BODY });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email: SIGNUP_BODY.email, displayName: null });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.apiKey).toBeUndefined();
    expect(body.plaintext).toBeUndefined();

    const cookie = res.cookies.find((c) => c.name === USER_SESSION_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);

    await app.close();
  });

  it("rejects a duplicate email", async () => {
    const app = await buildApp();
    await signup(app);

    const res = await app.inject({ method: "POST", url: "/user/signup", payload: SIGNUP_BODY });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/already exists/i);

    await app.close();
  });

  it("rejects a too-short password", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/user/signup",
      payload: { email: "short@example.com", password: "abc" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("lowercases and trims the email, and stores an optional display name", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/user/signup",
      payload: { email: "  Mixed@Example.com  ", password: "correct-horse-battery", displayName: "Rami" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: "mixed@example.com", displayName: "Rami" });
    await app.close();
  });
});

describe("user login", () => {
  it("signs in with the right password", async () => {
    const app = await buildApp();
    await signup(app);

    const res = await app.inject({ method: "POST", url: "/user/login", payload: SIGNUP_BODY });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === USER_SESSION_COOKIE)).toBeTruthy();

    await app.close();
  });

  it("rejects the wrong password", async () => {
    const app = await buildApp();
    await signup(app);

    const res = await app.inject({
      method: "POST",
      url: "/user/login",
      payload: { email: SIGNUP_BODY.email, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("rejects an unknown email with the same status/message as a wrong password (no enumeration)", async () => {
    const app = await buildApp();
    const unknownRes = await app.inject({
      method: "POST",
      url: "/user/login",
      payload: { email: "nobody@example.com", password: "whatever12345" },
    });

    await signup(app);
    const wrongPasswordRes = await app.inject({
      method: "POST",
      url: "/user/login",
      payload: { email: SIGNUP_BODY.email, password: "wrong-password" },
    });

    expect(unknownRes.statusCode).toBe(wrongPasswordRes.statusCode);
    expect(unknownRes.json().message).toBe(wrongPasswordRes.json().message);

    await app.close();
  });
});

describe("user session", () => {
  it("requires a session for /user/session and /user/me", async () => {
    const app = await buildApp();
    const sessionRes = await app.inject({ method: "GET", url: "/user/session" });
    expect(sessionRes.statusCode).toBe(401);
    const meRes = await app.inject({ method: "GET", url: "/user/me" });
    expect(meRes.statusCode).toBe(401);
    await app.close();
  });

  it("is valid right after signup, and cleared after logout", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    const sessionRes = await app.inject({ method: "GET", url: "/user/session", cookies });
    expect(sessionRes.statusCode).toBe(200);

    const logoutRes = await app.inject({ method: "POST", url: "/user/logout", cookies });
    const cleared = logoutRes.cookies.find((c) => c.name === USER_SESSION_COOKIE);
    expect(cleared?.value).toBe("");

    await app.close();
  });

  it("GET /user/me returns the signed-in user's profile", async () => {
    const app = await buildApp();
    const { cookies, body } = await signup(app);

    const res = await app.inject({ method: "GET", url: "/user/me", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: body.user.id, email: SIGNUP_BODY.email });

    await app.close();
  });
});

describe("wallet linking", () => {
  it("links a wallet and lists it back with live (zeroed, no HELIUS key in tests) pnl fields", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    const linkRes = await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies,
      payload: { chain: "solana", address: "user-test-wallet-1", label: "Main" },
    });
    expect(linkRes.statusCode).toBe(201);
    expect(linkRes.json().wallet).toMatchObject({ chain: "solana", address: "user-test-wallet-1", label: "Main" });

    const listRes = await app.inject({ method: "GET", url: "/user/wallets", cookies });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().wallets).toEqual([
      expect.objectContaining({
        chain: "solana",
        address: "user-test-wallet-1",
        label: "Main",
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        totalPnlUsd: 0,
        positionsOpen: 0,
      }),
    ]);

    await app.close();
  });

  it("rejects linking the same wallet twice for the same user", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);
    const payload = { chain: "solana" as const, address: "user-test-wallet-dup" };

    await app.inject({ method: "POST", url: "/user/wallets", cookies, payload });
    const res = await app.inject({ method: "POST", url: "/user/wallets", cookies, payload });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/already linked/i);

    await app.close();
  });

  it("enforces the per-account wallet cap", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    for (let i = 0; i < USER_MAX_WALLETS; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/user/wallets",
        cookies,
        payload: { chain: "solana", address: `user-test-wallet-cap-${i}` },
      });
      expect(res.statusCode).toBe(201);
    }

    const overCap = await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies,
      payload: { chain: "solana", address: "user-test-wallet-cap-over" },
    });
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json().message).toMatch(/max/i);

    await app.close();
  });

  it("unlinks a wallet, scoped to the caller -- another user can't unlink it", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);
    const other = await signup(app, { email: "other@example.com", password: "correct-horse-battery" });

    const linkRes = await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies,
      payload: { chain: "solana", address: "user-test-wallet-unlink" },
    });
    const walletId = linkRes.json().wallet.walletId;

    const otherUnlink = await app.inject({
      method: "POST",
      url: `/user/wallets/${walletId}/unlink`,
      cookies: other.cookies,
    });
    expect(otherUnlink.statusCode).toBe(404);

    const ownUnlink = await app.inject({ method: "POST", url: `/user/wallets/${walletId}/unlink`, cookies });
    expect(ownUnlink.statusCode).toBe(200);
    expect(ownUnlink.json()).toEqual({ unlinked: true });

    const listRes = await app.inject({ method: "GET", url: "/user/wallets", cookies });
    expect(listRes.json().wallets).toEqual([]);

    await app.close();
  });
});

describe("GET /user/portfolio", () => {
  it("sums real stored realized PnL over the range and reports a sparkline + win rate", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    const linkRes = await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies,
      payload: { chain: "solana", address: "user-test-wallet-portfolio" },
    });
    const walletId = linkRes.json().wallet.walletId;

    const today = new Date();
    const iso = (daysAgo: number) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysAgo));
      return d.toISOString().slice(0, 10);
    };
    await pool.query(
      `insert into daily_realized_pnl (wallet_id, day, realized_pnl_usd, trade_count) values
         ($1, $2, 100, 2), ($1, $3, -30, 1), ($1, $4, 50, 1)`,
      [walletId, iso(1), iso(2), iso(3)],
    );

    const res = await app.inject({ method: "GET", url: "/user/portfolio?range=7d", cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.realizedPnlUsd).toBe(120); // 100 - 30 + 50
    expect(body.unrealizedPnlUsd).toBe(0); // no HELIUS key in tests -> zeroed live figures
    expect(body.totalPnlUsd).toBe(120);
    expect(body.linkedWallets).toBe(1);
    expect(body.winRate30d).toBe(67); // 2 of 3 tracked days positive, rounded
    expect(Array.isArray(body.sparkline)).toBe(true);
    expect(body.sparkline).toHaveLength(7);
    expect(body.sparkline.at(-1).cumulativeRealizedPnlUsd).toBe(120);
    expect(body.primaryWallet).toEqual({ chain: "solana", address: "user-test-wallet-portfolio" });

    await app.close();
  });

  it("reports null winRate30d and zero figures for an account with no tracked days", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);
    await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies,
      payload: { chain: "solana", address: "user-test-wallet-empty" },
    });

    const res = await app.inject({ method: "GET", url: "/user/portfolio", cookies });
    const body = res.json();
    expect(body.realizedPnlUsd).toBe(0);
    expect(body.winRate30d).toBeNull();

    await app.close();
  });
});

describe("GET /user/calendar", () => {
  it("returns every day of the month, marking real-data days as tracked", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    const linkRes = await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies,
      payload: { chain: "solana", address: "user-test-wallet-calendar" },
    });
    const walletId = linkRes.json().wallet.walletId;
    // A second linked wallet, to prove day totals SUM across wallets, not
    // just report one wallet's number.
    const linkRes2 = await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies,
      payload: { chain: "solana", address: "user-test-wallet-calendar-2" },
    });
    const walletId2 = linkRes2.json().wallet.walletId;

    await pool.query(
      `insert into daily_realized_pnl (wallet_id, day, realized_pnl_usd, trade_count) values
         ($1, '2026-09-03', 75.5, 4),
         ($1, '2026-09-10', -12, 1),
         ($2, '2026-09-10', -3, 1)`,
      [walletId, walletId2],
    );

    const res = await app.inject({ method: "GET", url: "/user/calendar?month=2026-09", cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.month).toBe("2026-09");
    expect(body.days).toHaveLength(30);

    const day1 = body.days.find((d: { date: string }) => d.date === "2026-09-01");
    expect(day1).toMatchObject({ realizedPnlUsd: 0, tradeCount: 0, tracked: false });

    const day3 = body.days.find((d: { date: string }) => d.date === "2026-09-03");
    expect(day3).toMatchObject({ realizedPnlUsd: 75.5, tradeCount: 4, tracked: true });

    const day10 = body.days.find((d: { date: string }) => d.date === "2026-09-10");
    expect(day10).toMatchObject({ realizedPnlUsd: -15, tradeCount: 2, tracked: true });

    await app.close();
  });

  it("rejects a malformed month", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);
    const res = await app.inject({ method: "GET", url: "/user/calendar?month=not-a-month", cookies });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
