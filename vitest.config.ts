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
  },
});
