import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The "dev" x-api-key convenience is gated behind ALLOW_DEV_KEY (see
    // src/config.ts / src/plugins/apiKey.ts) so it's dead by default on
    // any real deploy that never sets it. The whole test suite relies on
    // that key, so turn it on explicitly here rather than the tests
    // silently depending on a var nobody set.
    env: {
      ALLOW_DEV_KEY: "true",
    },
    // Several suites (db-api-keys.test.ts, api-key-auth.test.ts,
    // rate-limit.test.ts, waitlist.test.ts, ...) share one real Postgres
    // instance and each starts with a `beforeEach` that truncates the
    // tables it owns. That's safe within a single file (tests in one file
    // run sequentially), but Vitest's default file parallelism runs
    // different test *files* concurrently in separate worker processes --
    // against the same shared database, so one file's truncate can wipe
    // rows out from under a still-running test in another file. This was
    // always a latent race; it surfaced concretely once rate-limit.test.ts
    // added tests long enough (looping ~70 requests) to reliably overlap
    // with another file's truncate. Turning off file parallelism trades a
    // small amount of wall-clock time for deterministic runs against the
    // shared DB -- the right tradeoff here since these are integration
    // tests, not unit tests, and there's no per-file schema/transaction
    // isolation to fall back on instead.
    fileParallelism: false,
  },
});
