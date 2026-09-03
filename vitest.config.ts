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
      // test/admin.test.ts logs in for real via POST /admin/login -- set
      // explicitly (rather than relying on src/config.ts's own dev
      // defaults, which happen to be the same values) so the test suite
      // doesn't silently depend on a coincidence nobody set on purpose.
      // Hash corresponds to the plaintext "admin-dev-password" -- see
      // ADMIN_PASSWORD in test/admin.test.ts.
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH:
        "4b3fd450160c2d4b142ab0afd65255de:a3683f9381635ac75724080fe92923ddf02300d524c4bb98af04134d6da249530b65e58d3cfcac5e0ab5a8777407d1d8687b0a26b24a7da8b8a2962260a4e17d",
      ADMIN_SESSION_SECRET: "test-admin-session-secret",
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
