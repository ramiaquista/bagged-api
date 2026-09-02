import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";

export interface WaitlistNotifySignup {
  email: string;
  note?: string;
}

export interface WaitlistNotifyOptions {
  /** Injectable for tests -- never make a real network call from a test. */
  fetchImpl?: typeof fetch;
}

/**
 * Notifies WAITLIST_NOTIFY_EMAIL (default business@bagged.life) by email
 * whenever a genuinely new visitor joins the waitlist, so a human can
 * follow up. This is currently the ONLY "we'll be in touch" mechanism --
 * key issuance on this route was deliberately reverted to a manual,
 * by-hand process (see commit f791ae2 and CtaSection.tsx's own copy,
 * "keys are issued by hand, we'll follow up by email"), so without this
 * the only way to notice a new signup was to remember to poll
 * GET /waitlist.
 *
 * Sent via Resend's HTTP API (https://resend.com) with a plain fetch call
 * -- no SMTP, no new npm dependency, same fetchImpl-injectable idiom as
 * src/worker/deliver.ts's webhook delivery. `reply_to` is set to the
 * signer-upper's own address, so replying to the notification email goes
 * straight to them.
 *
 * Fully optional and never fails the signup it's attached to: with no
 * RESEND_API_KEY configured this no-ops (logs once at warn, never
 * throws) -- same graceful-degradation shape as HELIUS_API_KEY /
 * ALCHEMY_API_KEY / SENTRY_DSN elsewhere in this codebase. Called from
 * routes/waitlist.ts AFTER the waitlist insert has already committed, so
 * a failed or slow email can never roll back or block the signup itself.
 *
 * Never throws. Returns true if the notification was actually sent (for
 * tests/observability), false otherwise (not configured, or the send
 * failed) -- callers should not branch on this; it's informational only.
 */
export async function notifyWaitlistSignup(
  signup: WaitlistNotifySignup,
  logger: FastifyBaseLogger,
  options: WaitlistNotifyOptions = {},
): Promise<boolean> {
  if (!config.RESEND_API_KEY) {
    logger.warn(
      { email: signup.email },
      "RESEND_API_KEY not set -- skipping waitlist signup notification email",
    );
    return false;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const to = config.WAITLIST_NOTIFY_EMAIL;
  const text = [
    `New Bagged waitlist signup: ${signup.email}`,
    "",
    signup.note ? `Note: ${signup.note}` : "(no note provided)",
    "",
    `Signed up: ${new Date().toISOString()}`,
    "",
    `Reply to this email to reach out directly -- it's addressed back to ${signup.email}.`,
  ].join("\n");

  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Bagged Waitlist <onboarding@resend.dev>",
        to: [to],
        reply_to: signup.email,
        subject: `New waitlist signup: ${signup.email}`,
        text,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { email: signup.email, status: res.status, body },
        "waitlist signup notification email failed to send",
      );
      return false;
    }

    logger.info({ email: signup.email, to }, "waitlist signup notification email sent");
    return true;
  } catch (err) {
    logger.warn(
      { email: signup.email, err: (err as Error).message },
      "waitlist signup notification email threw",
    );
    return false;
  }
}
