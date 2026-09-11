import type { FastifyBaseLogger } from "fastify";
import { Resend } from "resend";
import { config } from "../config.js";

/**
 * Sends a professional welcome email to someone who joins the waitlist.
 * Includes the Bagged logo and marketing content about the platform.
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

  // Professional HTML email template with logo and marketing content
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Bagged</title>
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
      background: #f9fafb;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }
    .header {
      background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
      padding: 40px 20px;
      text-align: center;
    }
    .logo {
      height: 32px;
      margin-bottom: 20px;
    }
    .header h1 {
      color: white;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .header p {
      color: #d1d5db;
      font-size: 14px;
    }
    .content {
      padding: 40px;
    }
    .greeting {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #1a1a1a;
    }
    .section {
      margin-bottom: 32px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      color: #1a1a1a;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-content {
      color: #4b5563;
      font-size: 14px;
      line-height: 1.8;
    }
    .feature-list {
      list-style: none;
      margin: 12px 0;
    }
    .feature-list li {
      padding-left: 24px;
      position: relative;
      margin-bottom: 10px;
      color: #4b5563;
      font-size: 14px;
    }
    .feature-list li:before {
      content: "✓";
      position: absolute;
      left: 0;
      color: #10b981;
      font-weight: bold;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
      color: white;
      padding: 12px 28px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      margin: 20px 0;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(14, 165, 233, 0.4);
    }
    .divider {
      border-top: 1px solid #e5e7eb;
      margin: 32px 0;
    }
    .footer {
      background: #f9fafb;
      padding: 24px 40px;
      border-top: 1px solid #e5e7eb;
      text-align: center;
    }
    .footer-links {
      margin-bottom: 16px;
      font-size: 13px;
    }
    .footer-links a {
      color: #0284c7;
      text-decoration: none;
      margin: 0 12px;
    }
    .footer-text {
      color: #6b7280;
      font-size: 12px;
      line-height: 1.6;
    }
    .highlight {
      color: #0284c7;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div style="font-size: 28px; margin-bottom: 8px;">📊</div>
      <h1>Welcome to Bagged</h1>
      <p>Your all-in-one crypto portfolio PnL tracker</p>
    </div>

    <!-- Content -->
    <div class="content">
      <p class="greeting">Thanks for joining the waitlist!</p>

      <div class="section">
        <p class="section-content">
          We're excited to have you on board. Bagged is revolutionizing how crypto traders track their portfolio performance across all chains and exchanges in one place.
        </p>
      </div>

      <div class="section">
        <div class="section-title">💡 What's Bagged?</div>
        <p class="section-content">
          Bagged provides real-time P&L tracking, comprehensive portfolio analytics, and detailed trade history analysis — all the insights you need to understand your crypto performance.
        </p>
      </div>

      <div class="section">
        <div class="section-title">✨ Key Features</div>
        <ul class="feature-list">
          <li>Track P&L across all chains (Solana, Ethereum, BNB, and more)</li>
          <li>Connect multiple wallets and exchanges in seconds</li>
          <li>Daily P&L calendar to track your daily wins and losses</li>
          <li>Real-time portfolio analytics and performance metrics</li>
          <li>RESTful API for custom integrations</li>
          <li>Webhook notifications for threshold alerts</li>
        </ul>
      </div>

      <div class="section" style="text-align: center;">
        <p style="color: #4b5563; font-size: 14px; margin-bottom: 12px;">
          We're working hard to get Bagged ready for launch. <span class="highlight">We'll reach out soon</span> with early access details.
        </p>
      </div>

      <div class="divider"></div>

      <div class="section">
        <div class="section-title">🚀 What's Next?</div>
        <p class="section-content">
          In the meantime, you can:
        </p>
        <ul class="feature-list">
          <li>Explore our documentation and API reference at <a href="https://bagged.life/docs" style="color: #0284c7; text-decoration: none;">bagged.life/docs</a></li>
          <li>Join our community and share your feedback</li>
          <li>Follow us on social media for product updates</li>
        </ul>
      </div>

      <div class="section" style="text-align: center;">
        <p style="color: #4b5563; font-size: 14px; margin-top: 24px;">
          Questions? Feel free to reply to this email or reach out at <a href="mailto:hello@bagged.life" style="color: #0284c7; text-decoration: none;">hello@bagged.life</a>
        </p>
      </div>
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
        You received this email because you signed up for the Bagged waitlist.
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();

  try {
    const result = await resend.emails.send({
      from: "Bagged <onboarding@resend.dev>",
      to: email,
      subject: "Welcome to Bagged — Thanks for joining the waitlist!",
      html: htmlContent,
      replyTo: "hello@bagged.life",
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
