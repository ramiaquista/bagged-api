import type { FastifyBaseLogger } from "fastify";
import { Resend } from "resend";
import { config } from "../config.js";

/**
 * Sends a professional welcome email to someone who joins the waitlist.
 * Branded template with Bagged logo and color scheme.
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

  // Premium, branded HTML email template
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're In — Bagged Early Access</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #f5f5f5;
    }
    .wrapper {
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
    .header {
      background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
      padding: 48px 32px;
      text-align: center;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 16px;
    }
    .header h1 {
      color: white;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    .header-subtitle {
      color: #b0b0b0;
      font-size: 14px;
      font-weight: 500;
    }
    .content {
      padding: 48px 32px;
    }
    .greeting {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 20px;
      color: #1a1a1a;
    }
    .intro-text {
      font-size: 15px;
      line-height: 1.8;
      color: #4b5563;
      margin-bottom: 32px;
    }
    .highlight-text {
      color: #0284c7;
      font-weight: 600;
    }
    .section {
      margin-bottom: 36px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: #1a1a1a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .feature-list {
      list-style: none;
      margin: 0;
    }
    .feature-list li {
      padding-left: 24px;
      position: relative;
      margin-bottom: 12px;
      color: #4b5563;
      font-size: 14px;
      line-height: 1.6;
    }
    .feature-list li:before {
      content: "→";
      position: absolute;
      left: 0;
      color: #0284c7;
      font-weight: bold;
      font-size: 16px;
    }
    .feature-list a {
      color: #0284c7;
      text-decoration: none;
      font-weight: 500;
    }
    .cta-section {
      background: linear-gradient(135deg, #0284c7 0%, #0166a8 100%);
      border-radius: 8px;
      padding: 32px;
      text-align: center;
      margin: 40px 0;
    }
    .cta-text {
      color: white;
      font-size: 14px;
      margin-bottom: 16px;
      line-height: 1.6;
    }
    .cta-button {
      display: inline-block;
      background: white;
      color: #0284c7;
      padding: 12px 32px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      transition: transform 0.2s, box-shadow 0.2s;
      border: none;
      cursor: pointer;
    }
    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 16px rgba(2, 132, 199, 0.3);
    }
    .divider {
      border-top: 1px solid #e5e7eb;
      margin: 32px 0;
    }
    .footer {
      background: #f9fafb;
      padding: 32px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
    }
    .footer-text {
      color: #6b7280;
      font-size: 12px;
      line-height: 1.8;
    }
    .footer-links {
      margin-bottom: 20px;
      font-size: 13px;
    }
    .footer-links a {
      color: #0284c7;
      text-decoration: none;
      margin: 0 12px;
      font-weight: 500;
    }
    .badge {
      display: inline-block;
      background: #e0f2fe;
      color: #0284c7;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <!-- Header -->
      <div class="header">
        <div class="logo">📊</div>
        <h1>You're In</h1>
        <p class="header-subtitle">Early access to Bagged</p>
      </div>

      <!-- Content -->
      <div class="content">
        <p class="greeting">Hey there 👋</p>

        <p class="intro-text">
          Thanks for joining the Bagged waitlist. You're part of an early group of traders who are about to get access to something that changes how crypto traders think about their P&L.
        </p>

        <div class="badge">🚀 EARLY ACCESS</div>

        <div class="section">
          <div class="section-title">Why Bagged Exists</div>
          <p class="intro-text" style="margin-bottom: 0;">
            Tracking crypto performance across chains and exchanges is a nightmare. Most traders use spreadsheets, gut feeling, or fragmented tools that don't talk to each other. Bagged fixes this.
          </p>
        </div>

        <div class="section">
          <div class="section-title">What You Get</div>
          <ul class="feature-list">
            <li>Real-time P&L tracking across Solana, Ethereum, BNB, and more</li>
            <li>Daily P&L calendar — see exactly what you made or lost each day</li>
            <li>Multi-wallet support — connect all your addresses in seconds</li>
            <li>Comprehensive trade history and performance analytics</li>
            <li>API access for builders and integrations</li>
          </ul>
        </div>

        <!-- CTA Section -->
        <div class="cta-section">
          <p class="cta-text">
            We're launching soon with early access for waitlist members. You'll be among the first to experience Bagged.
          </p>
          <p class="cta-text" style="margin-bottom: 24px; font-weight: 600; font-size: 15px;">
            You'll hear from us with launch details very soon.
          </p>
        </div>

        <div class="section">
          <div class="section-title">In The Meantime</div>
          <ul class="feature-list">
            <li><a href="https://bagged.life/docs">Check out our API docs</a> to see what's coming</li>
            <li>Follow us on <a href="https://x.com/baggedlife">X (Twitter)</a> for updates</li>
            <li>Have ideas? Reply to this email — we read everything</li>
          </ul>
        </div>

        <p class="intro-text" style="margin-top: 32px;">
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
          © 2026 Bagged. All rights reserved.<br>
          You received this because you joined the waitlist at bagged.life
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
      subject: "You're In — Bagged Early Access",
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
