import fs from 'fs';
import path from 'path';

// ============================================================
// EMAIL CONFIGURATION STARTUP VALIDATION
// ============================================================
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@nexakite.shop';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Startup validation logging
if (!process.env.FROM_EMAIL) {
  console.warn('⚠️  [EMAIL CONFIG] WARNING: FROM_EMAIL environment variable is not set. Falling back to: noreply@nexakite.shop');
  console.warn('⚠️  [EMAIL CONFIG] Set FROM_EMAIL=noreply@nexakite.shop in your Railway/Render environment variables.');
} else {
  console.log(`✅ [EMAIL CONFIG] Sender address configured: ${FROM_EMAIL}`);
}

if (!RESEND_API_KEY) {
  console.warn('⚠️  [EMAIL CONFIG] WARNING: RESEND_API_KEY is not set. Emails will be simulated only.');
} else {
  console.log(`✅ [EMAIL CONFIG] Resend API key detected (length: ${RESEND_API_KEY.length}).`);
}

// Background Queue Simulator (for standard transactional tasks with automated retry & exponential backoff)
export const emailDispatchQueue: Array<{
  id: string;
  to: string;
  type: string;
  mailOptions: any;
  attempts: number;
  status: 'PENDING' | 'SENT' | 'FAILED';
  error?: string;
}> = [];

// Helper to determine from address dynamically — always uses verified domain
function getFromAddress(): string {
  return process.env.FROM_EMAIL || 'noreply@nexakite.shop';
}

// Resend HTTP API Client implementation using native global fetch
async function sendViaResend(payload: {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: string }>;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const obscuredSubject = payload.subject.replace(/\b\d{6}\b/g, '******');
    console.log(`📬 [RESEND LOG FALLBACK] No RESEND_API_KEY defined. Simulating delivery:`);
    console.log(`- From: ${payload.from}`);
    console.log(`- To: ${Array.isArray(payload.to) ? payload.to.join(', ') : payload.to}`);
    console.log(`- Subject: ${obscuredSubject}`);
    return { id: `simulated-${Date.now()}` };
  }

  const resendUrl = 'https://api.resend.com/emails';
  const recipientList = Array.isArray(payload.to) ? payload.to : [payload.to];
  const formattedRecipients = recipientList.map(r => r.trim().toLowerCase());

  const body = {
    from: payload.from,
    to: formattedRecipients,
    subject: payload.subject,
    html: payload.html,
    attachments: payload.attachments || []
  };

  console.log(`📨 [RESEND API] Sending from: ${payload.from} → to: ${formattedRecipients.join(', ')}...`);

  const response = await fetch(resendUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  if (!response.ok) {
    let errMessage = responseText;
    try {
      const parsed = JSON.parse(responseText);
      errMessage = parsed.message || JSON.stringify(parsed);
    } catch {}
    throw new Error(`Resend API error (Status ${response.status}): ${errMessage}`);
  }

  try {
    const data = JSON.parse(responseText);
    console.log(`✅ [RESEND SUCCESS] Email delivered successfully. ID: ${data.id}`);
    return data;
  } catch {
    console.log(`✅ [RESEND SUCCESS] Email delivered. Response length: ${responseText.length}`);
    return { id: `unknown-${Date.now()}` };
  }
}

async function triggerBackgroundEmailWorker() {
  const pending = emailDispatchQueue.find(j => j.status === 'PENDING' && j.attempts < 3);
  if (!pending) return;

  pending.attempts++;

  try {
    const res = await sendViaResend(pending.mailOptions);
    console.log(`📨 [RESEND QUEUE] Successfully sent "${pending.type}" to ${pending.to}. ID:`, res?.id);
    pending.status = 'SENT';
  } catch (err: any) {
    console.error(`❌ [RESEND QUEUE] Dispatch failed on attempt ${pending.attempts}: ${err.message}`);
    if (pending.attempts >= 3) {
      pending.status = 'FAILED';
      pending.error = err.message;
    } else {
      const retryMs = pending.attempts === 1 ? 5000 : 30000;
      setTimeout(() => {
        pending.status = 'PENDING';
        triggerBackgroundEmailWorker();
      }, retryMs);
    }
  }

  setTimeout(triggerBackgroundEmailWorker, 100);
}

function queueEmail(to: string, type: string, mailOptions: any) {
  const jobId = `mail-job-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  emailDispatchQueue.push({
    id: jobId,
    to,
    type,
    mailOptions,
    attempts: 0,
    status: 'PENDING'
  });
  setTimeout(triggerBackgroundEmailWorker, 1);
  return jobId;
}

// Global brand elements
const brandHeaderHtml = `
  <div style="text-align: center; border-bottom: 2px solid #D4B896; padding-bottom: 20px; margin-bottom: 25px;">
    <img src="${process.env.FRONTEND_URL || 'https://godhara-fronted.vercel.app'}/logo.png" alt="Godhara Logo" style="width: 75px; height: 75px; display: inline-block; vertical-align: middle; margin-bottom: 12px; object-fit: contain;" />
    <h1 style="color: #6B2D0E; font-size: 26px; margin: 0 0 5px 0; font-family: 'Georgia', serif; font-weight: bold;">గోధార - Godhara</h1>
    <p style="margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #E8820C; font-weight: bold;">Traditional Ayurvedic Purities & Gau Seva</p>
  </div>
`;

const brandFooterHtml = `
  <div style="text-align: center; margin-top: 35px; border-top: 2px solid #D4B896; padding-top: 20px; font-size: 11px; color: #6B2D0E; font-family: sans-serif;">
    <p style="margin: 0; font-weight: bold;">Godhara Traditional Products</p>
    <p style="margin: 4px 0 0 0;">Pocharam Apartment, Banswada, Telangana 503187</p>
    <p style="margin: 12px 0 0 0; font-size: 9px; opacity: 0.6; line-height: 1.4;">
      This is an automated transactional message regarding your account settings. <br />
      If you did not request this, please secure your login instantly.
    </p>
  </div>
`;

// 1. CONFIRM EMAIL VERIFICATION
export async function sendEmailVerification(email: string, name: string, token: string) {
  const currentAppUrl = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
  const verifyLink = `${currentAppUrl}/verify-email?token=${token}`;

  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6; margin-top: 0;">Hare Krishna / Greetings <strong>${name}</strong>,</p>
      <p style="font-size: 14px; line-height: 1.6;">Thank you for registering at Godhara. Please verify your email address to activate your account.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verifyLink}" style="background-color: #6B2D0E; color: #FFFFFF; font-weight: bold; padding: 13px 28px; text-decoration: none; border-radius: 50px; display: inline-block; font-size: 14px;">Verify My Account</a>
      </div>
      <p style="font-size: 12px; color: #666; word-break: break-all; text-align: center;">Or copy this link: <br/><a href="${verifyLink}" style="color: #E8820C; text-decoration: none;">${verifyLink}</a></p>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Email Verification', {
    from: getFromAddress(),
    to: email,
    subject: 'Confirm Your Email Address - Godhara Traditional',
    html,
  });
}

// 2. WELCOME EMAIL AFTER VERIFICATION
export async function sendWelcomeEmail(email: string, name: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6; margin-top: 0;">Welcome home <strong>${name}</strong>,</p>
      <p style="font-size: 14px; line-height: 1.6;">Your account is active! Use code <strong>WELCOME10</strong> for 10% off your first order.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="https://godhara.com" style="background-color: #E8820C; color: #FFFFFF; font-weight: bold; padding: 13px 28px; text-decoration: none; border-radius: 50px; display: inline-block; font-size: 14px;">Explore Vedic Catalogues</a>
      </div>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Welcome Email', {
    from: getFromAddress(),
    to: email,
    subject: 'Welcome to Godhara Circle! Your account is active',
    html,
  });
}

// 3. PASSWORD RESET EMAIL
export async function sendPasswordResetEmail(email: string, name: string, token: string) {
  const currentAppUrl = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
  const resetLink = `${currentAppUrl}/reset-password?token=${token}`;

  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #6B2D0E; font-size: 18px; margin-top: 0;">Password Reset Request</h3>
      <p style="font-size: 14px; line-height: 1.6;">We received a password reset request for your Godhara login. This link expires in <strong>15 minutes</strong>.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetLink}" style="background-color: #6B2D0E; color: #FFFFFF; font-weight: bold; padding: 13px 28px; text-decoration: none; border-radius: 50px; display: inline-block; font-size: 14px;">Reset My Password</a>
      </div>
      <p style="font-size: 12px; color: #E8820C; text-align: center; font-weight: bold; text-transform: uppercase;">⚠️ Never share this link with anyone.</p>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Password Reset', {
    from: getFromAddress(),
    to: email,
    subject: 'Secure Password Reset Link - Godhara Traditional',
    html,
  });
}

// 4. PASSWORD CHANGED SECURITY WARNING
export async function sendPasswordChangedEmail(email: string, name: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #D32F2F; font-size: 18px; margin-top: 0;">Security Alert: Password Changed</h3>
      <p style="font-size: 14px; line-height: 1.6;">Greetings <strong>${name}</strong>, the password for your Godhara account has been updated successfully.</p>
      <div style="background-color: #FFEBEE; border-left: 4px solid #D32F2F; padding: 15px; margin: 20px 0; font-size: 13px; color: #5D4037; border-radius: 4px;">
        <strong>Was this not you?</strong> Please reset your password and contact support immediately.
      </div>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Password Changed Alert', {
    from: getFromAddress(),
    to: email,
    subject: 'Security Alert: Password Changed Successfully',
    html,
  });
}

// 5. LOGIN DEVICE ALERT
export async function sendLoginDeviceAlert(email: string, name: string, detail: { ip: string; browser: string; timestamp: string }) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #6B2D0E; font-size: 18px; margin-top: 0;">New Sign In Detected</h3>
      <p style="font-size: 14px; line-height: 1.6;">Greetings <strong>${name}</strong>, a new login session was established:</p>
      <div style="background-color: #F5EFE6; border: 1px solid #D4B896; padding: 18px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #2C1810; margin: 20px 0; line-height: 1.5;">
        • Client IP: ${detail.ip} <br />
        • Client Device: ${detail.browser} <br />
        • Time: ${detail.timestamp}
      </div>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Login Device Alert', {
    from: getFromAddress(),
    to: email,
    subject: 'Security Alert: New Sign-in Logged For Your Account',
    html,
  });
}

// 6. ACCOUNT LOCKED ALERT
export async function sendAccountLockedEmail(email: string, name: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #D32F2F; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #D32F2F; font-size: 18px; margin-top: 0;">Security Alert: Account Temporarily Locked</h3>
      <p style="font-size: 14px; line-height: 1.6;">Greetings <strong>${name}</strong>, your account has been locked after <strong>5 consecutive failed attempts</strong>.</p>
      <div style="background-color: #FFEBEE; border-left: 4px solid #D32F2F; padding: 15px; margin: 20px 0; font-size: 13px; color: #5D4037; border-radius: 4px; line-height: 1.5;">
        <strong>Lockout Duration:</strong> 15 Minutes
      </div>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Account Locked Alert', {
    from: getFromAddress(),
    to: email,
    subject: 'Security Notice: Account Temporarily Locked',
    html,
  });
}

// 7. OTP EMAIL (primary — direct send, not queued)
export async function sendOTPEmail(email: string, name: string, otp: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6; margin-top: 0;">Hare Krishna / Greetings <strong>${name}</strong>,</p>
      <p style="font-size: 14px; line-height: 1.6;">Your secure One-Time Passcode (OTP) is shown below. Valid for <strong>5 minutes</strong>.</p>
      <div style="text-align: center; margin: 30px 0; background-color: #FAF2E8; padding: 20px; border-radius: 8px; border: 1px dashed #D4B896;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #6B2D0E; font-family: monospace;">${otp}</span>
      </div>
      <p style="font-size: 12px; color: #E8820C; text-align: center; font-weight: bold;">⚠️ Never share this code with anyone.</p>
      ${brandFooterHtml}
    </div>
  `;

  const mailOptions = {
    from: getFromAddress(),
    to: email.trim().toLowerCase(),
    subject: `Your Secure Login Code: ${otp} - Godhara`,
    html,
  };

  try {
    await sendViaResend(mailOptions);
  } catch (err: any) {
    console.error(`❌ [RESEND FAILURE] Failed to deliver OTP email to ${email}. Error: ${err.message}`);
    throw new Error(`Email delivery failed: ${err.message}`);
  }
}

// 8. SPECIALIZED OTP EMAIL (for LOGIN / ADMIN_LOGIN purposes)
export async function sendOtpEmail(email: string, name: string, otp: string, purpose: 'LOGIN' | 'ADMIN_LOGIN') {
  const purposeText = purpose === 'ADMIN_LOGIN' ? 'Administrative Access' : 'Secure Login';
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6; margin-top: 0;">Hare Krishna / Greetings <strong>${name}</strong>,</p>
      <p style="font-size: 14px; line-height: 1.6;">OTP for <strong>${purposeText}</strong>. Valid for <strong>5 minutes</strong>.</p>
      <div style="text-align: center; margin: 30px 0; background-color: #FAF2E8; padding: 25px; border-radius: 12px; border: 2px dashed #6B2D0E;">
        <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #6B2D0E; font-family: monospace;">${otp}</span>
      </div>
      <p style="font-size: 12px; color: #D32F2F; text-align: center; font-weight: bold; margin-bottom: 4px;">⚠️ Expires in 5 minutes. Never share this code.</p>
      ${brandFooterHtml}
    </div>
  `;

  const mailOptions = {
    from: getFromAddress(),
    to: email.trim().toLowerCase(),
    subject: `[${purposeText} Code] ${otp} - Godhara`,
    html,
  };

  try {
    await sendViaResend(mailOptions);
  } catch (err: any) {
    console.error(`❌ [RESEND OTP FAILURE] Failed to deliver OTP to ${email}. Error: ${err.message}`);
    throw new Error(`Email delivery failed: ${err.message}`);
  }
}

// 9. ORDER CONFIRMATION EMAIL
export async function sendOrderConfirmationEmail(order: any, invoicePdfPath: string) {
  const settings = {
    storeName: process.env.STORE_NAME || 'Godhara',
    storePhone: process.env.STORE_PHONE || '+91 8978038932',
    storeEmail: process.env.STORE_EMAIL || 'support@godhara.com',
  };

  const emailSubject = `Order Confirmed! Your Godhara Order ${order.id} is placed.`;
  const emailHtml = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #F5EFE6; padding: 40px; color: #2C1810; max-width: 600px; margin: 0 auto; border: 4px solid #6B2D0E; border-radius: 8px;">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6;">Greetings, <strong>${order.shippingAddress.name}</strong>,</p>
      <p style="font-size: 15px; line-height: 1.6;">Your order has been placed successfully.</p>
      <div style="background-color: #FFFFFF; padding: 20px; border-radius: 4px; border: 1px dashed #D4B896; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #6B2D0E;">Order Details</h3>
        <p style="margin: 6px 0; font-size: 14px;"><strong>Order Reference:</strong> ${order.id}</p>
        <p style="margin: 6px 0; font-size: 14px;"><strong>Order Total:</strong> ₹${order.total.toFixed(2)}</p>
        <p style="margin: 6px 0; font-size: 14px;"><strong>Payment Status:</strong> ${order.paymentStatus || 'PENDING'}</p>
      </div>
      <p style="font-size: 14px; line-height: 1.6;">Tax Invoice (PDF) is attached for your records.</p>
      <p style="font-size: 14px;">Questions? Contact us on WhatsApp: <strong>${settings.storePhone}</strong></p>
      ${brandFooterHtml}
    </div>
  `;

  const attachments: Array<{ filename: string; content: string }> = [];
  if (invoicePdfPath && fs.existsSync(invoicePdfPath)) {
    try {
      const base64Content = fs.readFileSync(invoicePdfPath).toString('base64');
      attachments.push({
        filename: `Godhara-Invoice-${order.id}.pdf`,
        content: base64Content,
      });
    } catch (err: any) {
      console.error(`⚠️ [PDF ATTACH ERROR] Failed to encode PDF: ${err.message}`);
    }
  }

  const mailOptions = {
    from: getFromAddress(),
    to: order.shippingAddress.email || order.userId,
    subject: emailSubject,
    html: emailHtml,
    attachments,
  };

  queueEmail(mailOptions.to, 'Order Confirmation', mailOptions);
}

// 10. ADMIN ORDER NOTIFICATION
export async function sendAdminNewOrderNotificationEmail(order: any, adminEmail: string) {
  const itemsHtml = order.items
    .map(
      (item: any) =>
        `<li><strong>${item.name}</strong> (Qty: ${item.qty}) - ₹${(item.unitPrice * item.qty).toLocaleString()}</li>`
    )
    .join('');

  const emailSubject = `🚨 New Order Received! Order Ref: ${order.id}`;
  const emailHtml = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 600px; margin: 0 auto; border: 4px solid #E8820C; border-radius: 8px;">
      <h2 style="color: #6B2D0E; margin-top: 0; text-align: center; border-bottom: 2px solid #D4B896; padding-bottom: 12px;">🚨 New Store Order</h2>
      <p style="font-size: 15px; line-height: 1.6;">A new order has been received.</p>
      <div style="background-color: #FFFFFF; padding: 20px; border-radius: 4px; border: 1px dashed #D4B896; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #E8820C;">Customer Details</h3>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Name:</strong> ${order.shippingAddress.name}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Email:</strong> ${order.shippingAddress.email}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Phone:</strong> ${order.shippingAddress.phone}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Address:</strong> ${order.shippingAddress.street}, ${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.pincode}</p>
      </div>
      <div style="background-color: #FFFFFF; padding: 20px; border-radius: 4px; border: 1px dashed #D4B896; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #6B2D0E;">Ordered Products</h3>
        <ul style="font-size: 13px; padding-left: 20px; margin: 10px 0;">${itemsHtml}</ul>
        <p style="margin: 12px 0 0 0; font-size: 14px;"><strong>Total Paid:</strong> ₹${order.total.toLocaleString()}</p>
      </div>
      <p style="font-size: 13px; text-align: center; color: #777; margin-top: 30px;">Log in to the Admin Console to dispatch the order.</p>
    </div>
  `;

  const mailOptions = {
    from: getFromAddress(),
    to: adminEmail,
    subject: emailSubject,
    html: emailHtml,
  };

  queueEmail(adminEmail, 'Admin Order Notification', mailOptions);
}
