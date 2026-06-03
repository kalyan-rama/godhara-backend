import fs from 'fs';
import path from 'path';

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

// Helper to determine from address dynamically
function getFromAddress(): string {
  return process.env.FROM_EMAIL || 'Godhara <onboarding@resend.dev>';
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
    console.log(`📬 [RESEND LOG FALLBACK] No RESEND_API_KEY defined. Simulating delivery:`);
    console.log(`- From: ${payload.from}`);
    console.log(`- To: ${Array.isArray(payload.to) ? payload.to.join(', ') : payload.to}`);
    console.log(`- Subject: ${payload.subject}`);
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

  console.log(`📨 [RESEND API] Delivering email down channel to: ${formattedRecipients.join(', ')}...`);

  // Using Node 18+ global fetch
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
    console.log(`📨 [RESEND QUEUE] Successfully sent "${pending.type}" inside worker to ${pending.to}. ID:`, res?.id);
    pending.status = 'SENT';
  } catch (err: any) {
    console.error(`❌ [RESEND QUEUE] Dispatch failed on attempt ${pending.attempts}: ${err.message}`);
    if (pending.attempts >= 3) {
      pending.status = 'FAILED';
      pending.error = err.message;
    } else {
      // Retry with backoff
      const retryMs = pending.attempts === 1 ? 5000 : 30000;
      setTimeout(() => {
        pending.status = 'PENDING';
        triggerBackgroundEmailWorker();
      }, retryMs);
    }
  }

  // Next job in pipeline
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

// Global brand elements referencing process.env dynamically to avoid any hardcoded fallback domains
const brandHeaderHtml = `
  <div style="text-align: center; border-bottom: 2px solid #D4B896; padding-bottom: 20px; margin-bottom: 25px;">
    <img src="${process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000'}/assets/logo.png" alt="Godhara Logo" style="width: 75px; height: 75px; display: inline-block; vertical-align: middle; margin-bottom: 12px; object-fit: contain;" />
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
      If you did not request this, please secure your login instantly. <br />
      <a href="https://godhara.com/unsubscribe" style="color: #6B2D0E; text-decoration: underline;">Unsubscribe Preferences</a> | Banswada Seva Desk
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
      <p style="font-size: 14px; line-height: 1.6;">Thank you for registering at Godhara. To experience traditional Ayurveda and ancient Ghee recipes, please verify your email address to active your account within 24 hours.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verifyLink}" style="background-color: #6B2D0E; color: #FFFFFF; font-weight: bold; padding: 13px 28px; text-decoration: none; border-radius: 50px; display: inline-block; font-size: 14px; letter-spacing: 0.5px; box-shadow: 0 2px 5px rgba(0,0,0,0.15);">Verify My Account Address</a>
      </div>

      <p style="font-size: 12px; color: #666; word-break: break-all; text-align: center;">Or copy this link to browser: <br/><a href="${verifyLink}" style="color: #E8820C; text-decoration: none;">${verifyLink}</a></p>
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

// 2. WELCOME PERSONALIZED EMAIL AFTER VERIFICATION
export async function sendWelcomeEmail(email: string, name: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6; margin-top: 0;">Welcome home <strong>${name}</strong>,</p>
      <p style="font-size: 14px; line-height: 1.6;">Your contact email is officially verified! Your Seva Account is active and you can now order real Cow dung cups, pure hand-churned Vedic Bilona Ghee, and organic Panchagavya remedies.</p>
      
      <p style="font-size: 14px; line-height: 1.6;">To welcome you into our circle, use code <strong>WELCOME10</strong> to grab flat 10% off on your initial traditional cart.</p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="https://godhara.com" style="background-color: #E8820C; color: #FFFFFF; font-weight: bold; padding: 13px 28px; text-decoration: none; border-radius: 50px; display: inline-block; font-size: 14px;">Explore Vedic Catalogues</a>
      </div>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Welcome Email', {
    from: getFromAddress(),
    to: email,
    subject: 'Welcome to Godhara Circle! Your traditional account is active',
    html,
  });
}

// 3. SECURE PASSWORD RESET REQUEST EMAIL
export async function sendPasswordResetEmail(email: string, name: string, token: string) {
  const currentAppUrl = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
  const resetLink = `${currentAppUrl}/reset-password?token=${token}`;

  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #6B2D0E; font-size: 18px; margin-top: 0;">Password Reset Request</h3>
      <p style="font-size: 14px; line-height: 1.6;">We received a password reset request for your Godhara login. Click the button below to update your password. This link is secure and <strong>expires in 15 minutes</strong> for security reasons.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetLink}" style="background-color: #6B2D0E; color: #FFFFFF; font-weight: bold; padding: 13px 28px; text-decoration: none; border-radius: 50px; display: inline-block; font-size: 14px;">Reset My Password</a>
      </div>

      <p style="font-size: 12px; color: #E8820C; text-align: center; font-weight: bold; text-transform: uppercase;">⚠️ Avoid sharing this reset link with anyone.</p>
      <p style="font-size: 11px; color: #888; text-align: center; margin-top: 15px;">If you did not request this, please ignore this email. Your credentials remain safe and unmodified.</p>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Password Reset', {
    from: getFromAddress(),
    to: email,
    subject: 'Secure Passcode Reset Link - Godhara Traditional',
    html,
  });
}

// 4. PASSWORD CHANGED SECURITY WARNING email
export async function sendPasswordChangedEmail(email: string, name: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #D32F2F; font-size: 18px; margin-top: 0;">Security Alert: Password Changed</h3>
      <p style="font-size: 14px; line-height: 1.6;">Greetings <strong>${name}</strong>, this is an automated alert informing you that the password for your Godhara account has been updated successfully.</p>
      
      <div style="background-color: #FFEBEE; border-left: 4px solid #D32F2F; padding: 15px; margin: 20px 0; font-size: 13px; color: #5D4037; border-radius: 4px;">
        <strong>Was this not you?</strong> If you did not perform this change, your credentials may be compromised. Please lock down your account or contact support immediately on WhatsApp.
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

// 5. LOGIN FROM NEW DEVICE ALERT email
export async function sendLoginDeviceAlert(email: string, name: string, detail: { ip: string; browser: string; timestamp: string }) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #6B2D0E; font-size: 18px; margin-top: 0;">New Account Sign In Detected</h3>
      <p style="font-size: 14px; line-height: 1.6;">Greetings <strong>${name}</strong>, a new login session was established on your account:</p>
      
      <div style="background-color: #F5EFE6; border: 1px solid #D4B896; padding: 18px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #2C1810; margin: 20px 0; line-height: 1.5;">
        • Client IP: ${detail.ip} <br />
        • Client Device: ${detail.browser} <br />
        • Time Coordinate: ${detail.timestamp}
      </div>

      <p style="font-size: 12px; color: #888;">If you recognize this browser login session, no action is required. If this login was unauthorized, we recommend resetting your password immediately.</p>
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

// 6. ACCOUNT LOCKED OUT ALERT
export async function sendAccountLockedEmail(email: string, name: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #D32F2F; border-radius: 12px;">
      ${brandHeaderHtml}
      <h3 style="color: #D32F2F; font-size: 18px; margin-top: 0;">Security Alert: Account Temporarily Locked</h3>
      <p style="font-size: 14px; line-height: 1.6;">Greetings <strong>${name}</strong>, your account has been temporarily locked after <strong>5 consecutive failed password attempts</strong>.</p>
      
      <div style="background-color: #FFEBEE; border-left: 4px solid #D32F2F; padding: 15px; margin: 20px 0; font-size: 13px; color: #5D4037; border-radius: 4px; line-height: 1.5;">
        <strong>Lockout Duration:</strong> 15 Minutes <br />
        For security, all logins for this address have been disabled. Access will restore automatically, or you can invoke a passcode reset request if needed.
      </div>
      ${brandFooterHtml}
    </div>
  `;

  queueEmail(email, 'Account Locked Alert', {
    from: getFromAddress(),
    to: email,
    subject: 'Security Notice: Account Temporarily Lockout Activated',
    html,
  });
}

// 7. OTP DISPATCH EMAIL (Keep signature, route compatibility, and throw behavior intact)
export async function sendOTPEmail(email: string, name: string, otp: string) {
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6; margin-top: 0;">Hare Krishna / Greetings <strong>${name}</strong>,</p>
      <p style="font-size: 14px; line-height: 1.6;">Your secure single-use One-Time Passcode (OTP) is shown below. This code is valid for exactly <strong>5 minutes</strong> and will expire afterwards.</p>
      
      <div style="text-align: center; margin: 30px 0; background-color: #FAF2E8; padding: 20px; border-radius: 8px; border: 1px dashed #D4B896;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #6B2D0E; font-family: monospace;">${otp}</span>
      </div>

      <p style="font-size: 12px; color: #E8820C; text-align: center; font-weight: bold;">⚠️ For security, never share this passcode with anyone.</p>
      <p style="font-size: 11px; color: #888; text-align: center; margin-top: 15px;">If you did not request this OTP, please secure your login credentials immediately.</p>
      ${brandFooterHtml}
    </div>
  `;

  const mailOptions = {
    from: getFromAddress(),
    to: email.trim().toLowerCase(),
    subject: `Your Secure Login Passcode: ${otp} - Godhara`,
    html,
  };

  try {
    await sendViaResend(mailOptions);
  } catch (err: any) {
    console.error(`❌ [RESEND FAILURE] Failed to deliver OTP email to ${email}. Error: ${err.message}`);
    throw new Error(`Resend Mailer failed to dispatch verification token: ${err.message}`);
  }
}

// 8. NEW SPECIALIZED EXPORTED OTP FUNCTION
export async function sendOtpEmail(email: string, name: string, otp: string, purpose: 'LOGIN' | 'ADMIN_LOGIN') {
  const purposeText = purpose === 'ADMIN_LOGIN' ? 'Administrative Access' : 'Secure Login';
  const html = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 580px; margin: 0 auto; border: 3px solid #6B2D0E; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      ${brandHeaderHtml}
      <p style="font-size: 16px; line-height: 1.6; margin-top: 0;">Hare Krishna / Greetings <strong>${name}</strong>,</p>
      <p style="font-size: 14px; line-height: 1.6;">You requested a One-Time Passcode (OTP) for <strong>${purposeText}</strong>. Please use the secure code below to finalize your sign-in.</p>
      
      <div style="text-align: center; margin: 30px 0; background-color: #FAF2E8; padding: 25px; border-radius: 12px; border: 2px dashed #6B2D0E; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
        <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #6B2D0E; font-family: monospace; text-shadow: 1px 1px 0px #FFF;">${otp}</span>
      </div>

      <p style="font-size: 12px; color: #D32F2F; text-align: center; font-weight: bold; margin-bottom: 4px;">⚠️ Expiry Warning: This passcode is valid for exactly 5 minutes.</p>
      <p style="font-size: 11px; color: #777; text-align: center; margin-top: 4px;">Notice: Incorrect passcode entries are restricted. Maximum attempts warning is in effect to protect your account from brute-force threats.</p>
      
      <p style="font-size: 11px; color: #888; text-align: center; margin-top: 20px; line-height: 1.4;">
        If you did not initiate this login request, please ignore this email or change your password immediately to secure your Godhara circle account.
      </p>
      ${brandFooterHtml}
    </div>
  `;

  const mailOptions = {
    from: getFromAddress(),
    to: email.trim().toLowerCase(),
    subject: `[${purposeText} Verification Code] ${otp} - Godhara`,
    html,
  };

  try {
    await sendViaResend(mailOptions);
  } catch (err: any) {
    console.error(`❌ [RESEND OTP FAILURE] Failed to deliver specialized OTP email to ${email}. Error: ${err.message}`);
    throw new Error(`Resend Mailer failed to dispatch specialized verification token: ${err.message}`);
  }
}

// 9. TAX INVOICE DIRECT CONFIRMATION (Uses Base64 attachments)
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
      <p style="font-size: 15px; line-height: 1.6;">Thank you for your purchase with Godhara. Your order has been placed successfully and has been compiled at our associated traditional Gaushalas.</p>
      
      <div style="background-color: #FFFFFF; padding: 20px; border-radius: 4px; border: 1px dashed #D4B896; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #6B2D0E; border-bottom: 1px solid #F5EFE6; padding-bottom: 8px;">Order Details</h3>
        <p style="margin: 6px 0; font-size: 14px;"><strong>Order Reference:</strong> ${order.id}</p>
        <p style="margin: 6px 0; font-size: 14px;"><strong>Order Total:</strong> ₹${order.total.toFixed(2)}</p>
        <p style="margin: 6px 0; font-size: 14px;"><strong>Payment Status:</strong> ${order.paymentStatus || 'PENDING'}</p>
        <p style="margin: 6px 0; font-size: 14px;"><strong>Shipped Via:</strong> Gaushala Cargo Logistics</p>
      </div>

      <p style="font-size: 14px; line-height: 1.6;">We have attached the official <strong>TAX INVOICE (PDF)</strong> directly to this email for your bookkeeping records.</p>
      <p style="font-size: 14px; line-height: 1.6;">If you have any questions, feel free to ring us directly on WhatsApp at <strong>${settings.storePhone}</strong> or respond to this email.</p>
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
      console.error(`⚠️ [PDF ATTACH ERROR] Failed to read or encode PDF: ${err.message}`);
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

// 10. ADMIN ORDER NOTIFICATION (Queued using Resend format)
export async function sendAdminNewOrderNotificationEmail(order: any, adminEmail: string) {
  const settings = {
    storeName: process.env.STORE_NAME || 'Godhara',
    storePhone: process.env.STORE_PHONE || '+91 8978038932',
    storeEmail: process.env.STORE_EMAIL || 'support@godhara.com',
  };

  const itemsHtml = order.items
    .map(
      (item: any) =>
        `<li><strong>${item.name}</strong> (Qty: ${item.qty}) - ₹${(
          item.unitPrice * item.qty
        ).toLocaleString()}</li>`
    )
    .join('');

  const emailSubject = `🚨 New Order Received! Order Ref: ${order.id}`;
  const emailHtml = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #FAF8F5; padding: 40px; color: #2C1810; max-width: 600px; margin: 0 auto; border: 4px solid #E8820C; border-radius: 8px;">
      <h2 style="color: #6B2D0E; margin-top: 0; text-align: center; border-bottom: 2px solid #D4B896; padding-bottom: 12px;">🚨 New Store Order Processed</h2>
      <p style="font-size: 15px; line-height: 1.6;">Hare Krishna Admin, <br/> A new order has been paid and verified successfully via Razorpay.</p>
      
      <div style="background-color: #FFFFFF; padding: 20px; border-radius: 4px; border: 1px dashed #D4B896; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #E8820C;">Customer & Delivery Details</h3>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Customer Name:</strong> ${order.shippingAddress.name}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Email:</strong> ${order.shippingAddress.email}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Phone:</strong> ${order.shippingAddress.phone}</p>
        <p style="margin: 6px 0; font-size: 13px;"><strong>Delivery Address:</strong> ${order.shippingAddress.street}, ${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.pincode}</p>
      </div>

      <div style="background-color: #FFFFFF; padding: 20px; border-radius: 4px; border: 1px dashed #D4B896; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #6B2D0E;">Ordered Products</h3>
        <ul style="font-size: 13px; padding-left: 20px; margin: 10px 0;">
          ${itemsHtml}
        </ul>
        <p style="margin: 12px 0 0 0; font-size: 14px; border-top: 1px solid #FAF8F5; padding-top: 8px;"><strong>Total Amount Paid:</strong> ₹${order.total.toLocaleString()} (Goods: ₹${order.subtotal.toLocaleString()}, Delivery: ₹${order.shippingCharge.toLocaleString()})</p>
      </div>

      <div style="background-color: #F9F9F9; padding: 15px; border-radius: 4px; border: 1px solid #E2D1BE; margin: 20px 0; font-size: 12px;">
        <p style="margin: 4px 0;"><strong>Razorpay Payment ID:</strong> ${order.razorpayPaymentId || 'N/A'}</p>
        <p style="margin: 4px 0;"><strong>Payment Status:</strong> ${order.paymentStatus || 'PAID'}</p>
        <p style="margin: 4px 0;"><strong>Order Date & Time:</strong> ${new Date(order.createdAt).toLocaleString('en-US', { timeZone: 'UTC' })}</p>
      </div>

      <p style="font-size: 13px; text-align: center; color: #777; margin-top: 30px;">Log in to the Godhara Admin Console to print the shipping label and coordinate dispatch.</p>
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
