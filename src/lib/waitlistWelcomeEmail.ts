import type { FastifyBaseLogger } from "fastify";
import { Resend } from "resend";
import { config } from "../config.js";

/**
 * Sends a professional welcome email to waitlist signups.
 * P&L-focused design with banner as background, modern crypto aesthetic.
 *
 * Uses the Resend SDK (https://resend.com) for reliable email delivery.
 * Called after waitlist signup is committed, so failures don't affect the signup.
 * Gracefully degrades if RESEND_API_KEY is not configured.
 *
 * Never throws. Returns true if sent, false if skipped or failed.
 */
export async function sendWaitlistWelcomeEmail(
  email: string,
  logger: FastifyBaseLogger,
): Promise<boolean> {
  if (!config.RESEND_API_KEY) {
    logger.warn(
      { email },
      "RESEND_API_KEY not configured in environment -- skipping welcome email. Set RESEND_API_KEY to enable email delivery.",
    );
    return false;
  }

  const resend = new Resend(config.RESEND_API_KEY);

  // P&L-focused email template with banner as background
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're In — Bagged</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      line-height: 1.5;
      color: #1a1a1a;
      background: #fafafa;
    }
    .wrapper {
      width: 100%;
      background: #fafafa;
      padding: 16px;
    }
    .container {
      max-width: 700px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    }
    .hero {
      background: url('https://bagged.life/brand/logo-banner.png') center/contain no-repeat;
      background-color: #000000;
      padding: 40px;
      text-align: center;
      min-height: 200px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      position: relative;
    }
    .content {
      padding: 48px 40px;
    }
    .greeting {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #1a1a1a;
    }
    .intro {
      font-size: 14px;
      line-height: 1.7;
      color: #4b5563;
      margin-bottom: 32px;
    }
    .section {
      margin-bottom: 36px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      color: #1a1a1a;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 16px;
    }
    .section-title.highlight {
      color: #10b981;
    }
    .feature-list {
      list-style: none;
      margin: 0;
    }
    .feature-list li {
      padding-left: 20px;
      position: relative;
      margin-bottom: 10px;
      color: #4b5563;
      font-size: 14px;
      line-height: 1.6;
    }
    .feature-list li:before {
      content: "→";
      position: absolute;
      left: 0;
      color: #10b981;
      font-weight: bold;
      font-size: 16px;
    }
    .cta-box {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      border-radius: 6px;
      padding: 32px;
      text-align: center;
      margin: 32px 0;
    }
    .cta-box p {
      color: white;
      font-size: 14px;
      line-height: 1.7;
      margin-bottom: 12px;
    }
    .cta-box p.highlight {
      font-weight: 600;
      font-size: 15px;
      margin-bottom: 20px;
    }
    .cta-link {
      display: inline-block;
      color: #10b981;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
    }
    .divider {
      border-top: 1px solid #e5e7eb;
      margin: 32px 0;
    }
    .footer {
      background: #f9fafb;
      padding: 32px 40px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
    }
    .footer-links {
      margin-bottom: 16px;
      font-size: 13px;
    }
    .footer-links a {
      color: #10b981;
      text-decoration: none;
      margin: 0 12px;
      font-weight: 500;
    }
    .footer-text {
      color: #6b7280;
      font-size: 12px;
      line-height: 1.6;
    }
    a {
      color: #10b981;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <!-- Hero with banner background -->
      <div class="hero"></div>

      <!-- Content -->
      <div class="content">
        <p class="greeting">Welcome to the early access group</p>

        <p class="intro">
          You've joined Bagged at exactly the right time. We're weeks away from launch, and you'll be among the first traders to experience a completely different way of tracking crypto performance.
        </p>

        <div class="section">
          <div class="section-title highlight">What Bagged Does</div>
          <p class="intro" style="margin-bottom: 0;">
            Real-time P&L tracking across every chain and exchange you use. No spreadsheets. No guessing. Just clear numbers on what you've made and lost — today, this week, all time.
          </p>
        </div>

        <div class="section">
          <div class="section-title">The essentials you get</div>
          <ul class="feature-list">
            <li>⛓️ Multichain P&L (Solana, Ethereum, BNB, and more)</li>
            <li>📅 Daily P&L calendar — track wins and losses by day</li>
            <li>🪙 Connect unlimited wallets in seconds</li>
            <li>📈 Real-time portfolio analytics</li>
            <li>🔌 REST API for custom integrations</li>
          </ul>
        </div>

        <!-- CTA -->
        <div class="cta-box">
          <p>We're launching in the coming weeks with full early access for waitlist members.</p>
          <p class="highlight">You'll be first in line.</p>
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.9);">Check your email — we'll announce the exact date soon.</p>
        </div>

        <div class="section">
          <div class="section-title">In the meantime</div>
          <ul class="feature-list">
            <li>📚 Read our <a href="https://bagged.life/docs">API documentation</a> to see what's coming</li>
            <li>𝕏 Follow <a href="https://x.com/baggedlife">@baggedlife on X</a> for updates</li>
            <li>💬 Reply to this email with feedback — we read everything</li>
          </ul>
        </div>

        <p class="intro" style="margin-top: 32px; margin-bottom: 0;">
          See you at launch,<br>
          <strong>The Bagged Team</strong>
        </p>
      </div>

      <!-- Footer -->
      <div class="footer">
        <div class="footer-links">
          <a href="https://bagged.life">Website</a>
          <a href="https://bagged.life/docs">Docs</a>
          <a href="https://bagged.life/contact">Contact</a>
        </div>
        <p class="footer-text">
          © 2026 Bagged<br>
          You're on the waitlist because you signed up at bagged.life
        </p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();

  try {
    const result = await resend.emails.send({
      from: "Bagged <business@bagged.life>",
      to: email,
      subject: "You're In — Early Access to Bagged",
      html: htmlContent,
      replyTo: "business@bagged.life",
    });

    if (result.error) {
      logger.warn(
        { email, error: result.error },
        "waitlist welcome email failed to send",
      );
      return false;
    }

    logger.info({ email, messageId: result.data?.id }, "waitlist welcome email sent successfully");
    return true;
  } catch (err) {
    logger.warn(
      { email, err: (err as Error).message },
      "waitlist welcome email threw an error",
    );
    return false;
  }
}
