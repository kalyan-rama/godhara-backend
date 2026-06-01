import crypto from 'crypto';

interface OTPRecord {
  code: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

// In-Memory Secure OTP Cache
const otpStore = new Map<string, OTPRecord>();

// Cooldown tracking for resend requests (email -> timestamp in ms)
const resendCooldownStore = new Map<string, number>();

const OTP_TTL_MS = 5 * 60 * 1000; // 5-minute expiry
const COOLDOWN_MS = 60 * 1000;    // 60-second resend cooldown
const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * Generates a high-entropy cryptographically secure 6-digit OTP code string
 */
export function generateSecureOTP(): string {
  // Generates integer in range [100000, 999999] inclusive
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Checks if the email is currently in resend cooldown limits
 * @returns remaining seconds if restricted, or 0 if allowed
 */
export function getResendCooldownRemaining(email: string): number {
  const normEmail = email.toLowerCase().trim();
  const lastSent = resendCooldownStore.get(normEmail);
  if (!lastSent) return 0;

  const elapsed = Date.now() - lastSent;
  if (elapsed < COOLDOWN_MS) {
    return Math.ceil((COOLDOWN_MS - elapsed) / 1000);
  }
  return 0;
}

/**
 * Stores a newly generated OTP in memory, establishing expiry and updating resend cooldowns
 */
export function storeOTP(email: string, code: string): void {
  const normEmail = email.toLowerCase().trim();
  const now = Date.now();

  otpStore.set(normEmail, {
    code,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    createdAt: now,
  });

  resendCooldownStore.set(normEmail, now);
}

export type OTPVerifyResult = 
  | { success: true }
  | { success: false; reason: 'EXPIRED' | 'NOT_FOUND' | 'MAX_ATTEMPTS_EXCEEDED' | 'WRONG_CODE'; attemptsRemaining: number };

/**
 * Verifies a submitted OTP code, checking attempts and expiry with immediate destruction on success
 */
export function verifyOTPCode(email: string, submittedCode: string): OTPVerifyResult {
  const normEmail = email.toLowerCase().trim();
  const record = otpStore.get(normEmail);

  if (!record) {
    return { success: false, reason: 'NOT_FOUND', attemptsRemaining: 0 };
  }

  // 1. Check if expired
  if (Date.now() > record.expiresAt) {
    otpStore.delete(normEmail); // Clear expired structure
    return { success: false, reason: 'EXPIRED', attemptsRemaining: 0 };
  }

  // 2. Increment verification attempt counter
  record.attempts++;

  // 3. Validate code matching
  if (record.code !== submittedCode.trim()) {
    const attemptsRemaining = MAX_VERIFICATION_ATTEMPTS - record.attempts;
    if (attemptsRemaining <= 0) {
      otpStore.delete(normEmail); // Burn OTP after max attempts exceeded
      return { success: false, reason: 'MAX_ATTEMPTS_EXCEEDED', attemptsRemaining: 0 };
    }
    return { success: false, reason: 'WRONG_CODE', attemptsRemaining };
  }

  // 4. Verification successful: Clean state immediately to prevent reuse (strict requirement)
  otpStore.delete(normEmail);
  return { success: true };
}
