import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "../src/db/pool.js";

// Isolated from test/waitlist.test.ts specifically because it mocks
// src/db/apiKeys.ts's createApiKey -- vi.mock is file-scoped, so keeping
// this in its own file means the rest of the waitlist suite still exercises
// the real db/apiKeys.ts code path.
//
// Exercises NEXT_STEPS.md's Part 1 design decision 2: the waitlist insert
// and key creation happen in one transaction (src/routes/waitlist.ts),
// mirroring rotateApiKey's begin/commit/rollback pattern in
// src/db/apiKeys.ts. Forces the key-creation step to throw and asserts the
// waitlist row was NOT left behind either -- a crash between the two steps
// must not leave someone on the waitlist with no key and no error surfaced.
vi.mock("../src/db/apiKeys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/apiKeys.js")>();
  return {
    ...actual,
    createApiKey: vi.fn(async () => {
      throw new Error("simulated key-creation failure");
    }),
  };
});

// Imported after the mock is declared above (vitest hoists vi.mock calls to
// the top of the file regardless of source order, so this ordering is for
// human readability, not a functional requirement).
const { buildApp } = await import("../src/app.js");

const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table waitlist");
  await pool.query("truncate table api_key_usage, api_keys cascade");
});

afterAll(async () => {
  await pool.end();
});

describe("waitlist signup transaction rollback", () => {
  it("rolls back the waitlist insert when key creation throws", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "rollback@example.com" },
    });

    // createApiKey's thrown Error has no .statusCode, so app.ts's error
    // handler falls through to the generic 500 branch -- not the point of
    // this test, but asserted so a future change to that fallback doesn't
    // silently swallow the failure as a false "success".
    expect(res.statusCode).toBe(500);

    const waitlistRow = await pool.query("select 1 from waitlist where email = $1", [
      "rollback@example.com",
    ]);
    expect(waitlistRow.rowCount).toBe(0);

    const keyRow = await pool.query("select 1 from api_keys where owner_email = $1", [
      "rollback@example.com",
    ]);
    expect(keyRow.rowCount).toBe(0);

    await app.close();
  });
});
