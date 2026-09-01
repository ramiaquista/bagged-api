import * as Sentry from "@sentry/node";
import { config } from "../config.js";

/**
 * Optional error tracking/alerting. Fully inert (no init, no network
 * calls, no crash) until SENTRY_DSN is set -- there's no real DSN
 * provisioned yet, so this is scaffolding for when there is one.
 *
 * STATUS: scaffold. Wire up a real Sentry project and set SENTRY_DSN in
 * Railway to activate.
 */

let initialized = false;

export function initSentry(): void {
  if (!config.SENTRY_DSN) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
  });
  initialized = true;
}

/** No-ops unless initSentry() has run with a real DSN configured. */
export function captureException(err: unknown): void {
  if (!initialized) return;
  Sentry.captureException(err);
}

/** Exposed for tests only. */
export function _resetSentryStateForTests(): void {
  initialized = false;
}
