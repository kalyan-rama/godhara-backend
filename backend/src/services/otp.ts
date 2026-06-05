import crypto from 'crypto';

interface OTPRecord {
  codeHash: string;       // SHA-256 hash of the OTP — never stored plain
  expiresAt: number;
  attempts: number;
  createdAt: number;
  used: boolean;
}

// In-Memory Secure OTP Cache (keyed by normalized email)
const otpStore = new Map<string, OTPRecord>();

// Cooldown tracking for resend requests (email -> timestamp in ms)
const resendCooldownStore = new Map<string, number>();

// Temporary signup data store: email -> pending user payload (pre-account-creation)
const pendingSignupStore = new Map<string, { data: any; expiresAt: number }>();

const OTP_TTL_MS       = 10 * 60 * 1000; // 10-minute expiry (spec requirement)
const COOLDOWN_MS      = 60 * 1000;       // 60-second resend cooldown
const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * Generates a high-entropy cryptographically secure 6-digit OTP code string
 */
export function generateSecureOTP(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * SHA-256 hash of a raw OTP code — stored instead of plaintext
 */
function hashOTP(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
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
 * Stores a newly generated OTP in memory (hashed), establishing expiry and updating resend cooldowns.
 * The raw code is NOT stored — only its SHA-256 hash.
 */
export function storeOTP(email: string, code: string): void {
  const normEmail = email.toLowerCase().trim();
  const now = Date.now();

  otpStore.set(normEmail, {
    codeHash: hashOTP(code),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    createdAt: now,
    used: false,
  });

  resendCooldownStore.set(normEmail, now);
}

export type OTPVerifyResult =
  | { success: true }
  | { success: false; reason: 'EXPIRED' | 'NOT_FOUND' | 'MAX_ATTEMPTS_EXCEEDED' | 'WRONG_CODE' | 'ALREADY_USED'; attemptsRemaining: number };

/**
 * Verifies a submitted OTP code (hashed comparison), checking attempts, expiry, and reuse.
 * OTP is immediately destroyed on successful verification to prevent reuse.
 */
export function verifyOTPCode(email: string, submittedCode: string): OTPVerifyResult {
  const normEmail = email.toLowerCase().trim();
  const record = otpStore.get(normEmail);

  if (!record) {
    return { success: false, reason: 'NOT_FOUND', attemptsRemaining: 0 };
  }

  // 1. Prevent reuse
  if (record.used) {
    otpStore.delete(normEmail);
    return { success: false, reason: 'ALREADY_USED', attemptsRemaining: 0 };
  }

  // 2. Check expiry
  if (Date.now() > record.expiresAt) {
    otpStore.delete(normEmail);
    return { success: false, reason: 'EXPIRED', attemptsRemaining: 0 };
  }

  // 3. Increment verification attempt counter (checked BEFORE compare to prevent timing leaks)
  record.attempts++;

  // 4. Hash comparison (no plaintext stored)
  const submittedHash = hashOTP(submittedCode.trim());
  if (record.codeHash !== submittedHash) {
    const attemptsRemaining = MAX_VERIFICATION_ATTEMPTS - record.attempts;
    if (attemptsRemaining <= 0) {
      otpStore.delete(normEmail);
      return { success: false, reason: 'MAX_ATTEMPTS_EXCEEDED', attemptsRemaining: 0 };
    }
    return { success: false, reason: 'WRONG_CODE', attemptsRemaining };
  }

  // 5. Verification successful: mark as used and delete immediately to prevent reuse
  record.used = true;
  otpStore.delete(normEmail);
  return { success: true };
}

// ============================================================
// PENDING SIGNUP STORE — temp storage before account creation
// ============================================================

/**
 * Stores pending signup data temporarily while awaiting OTP confirmation.
 * Data expires after 15 minutes (OTP TTL + buffer for resends).
 */
export function storePendingSignup(email: string, data: any): void {
  const normEmail = email.toLowerCase().trim();
  pendingSignupStore.set(normEmail, {
    data,
    expiresAt: Date.now() + 15 * 60 * 1000
  });
}

/**
 * Retrieves and removes the pending signup data for the email.
 * Returns null if not found or expired.
 */
export function consumePendingSignup(email: string): any | null {
  const normEmail = email.toLowerCase().trim();
  const record = pendingSignupStore.get(normEmail);
  if (!record) return null;
  pendingSignupStore.delete(normEmail);
  if (Date.now() > record.expiresAt) return null;
  return record.data;
}

/**
 * Checks if there is a pending signup for an email (without consuming it).
 */
export function hasPendingSignup(email: string): boolean {
  const normEmail = email.toLowerCase().trim();
  const record = pendingSignupStore.get(normEmail);
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    pendingSignupStore.delete(normEmail);
    return false;
  }
  return true;
}
