import argon2 from "argon2";
import { UserDocument } from "./db";

export interface PublicUser {
  id: string;
  displayName: string;
  email: string;
  createdAt: string;
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      currentUser?: PublicUser;
    }
  }
}

// OWASP Password Storage Cheat Sheet baseline for Argon2id
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB in KiB
  timeCost: 2,
  parallelism: 1,
} as const;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().toLowerCase();
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    createdAt: user.createdAt,
  };
}

export async function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, ARGON2_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  plainPassword: string
): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plainPassword);
  } catch {
    return false;
  }
}

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function validateRegistrationInput(
  body: unknown
): ValidationResult<{ displayName: string; email: string; password: string }> {
  const payload = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;

  if (typeof payload.displayName !== "string") {
    return {
      ok: false,
      error: "Display name is required and must be a string.",
    };
  }
  const displayName = payload.displayName.trim();
  if (displayName.length < 2 || displayName.length > 50) {
    return {
      ok: false,
      error: "Display name must be between 2 and 50 characters.",
    };
  }

  if (typeof payload.email !== "string") {
    return { ok: false, error: "Email is required and must be a string." };
  }
  const email = normalizeEmail(payload.email);
  if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  if (typeof payload.password !== "string") {
    return { ok: false, error: "Password is required and must be a string." };
  }
  if (payload.password.length < 8 || payload.password.length > 128) {
    return {
      ok: false,
      error: "Password must be between 8 and 128 characters.",
    };
  }

  return { ok: true, data: { displayName, email, password: payload.password } };
}

export function validateLoginInput(
  body: unknown
): ValidationResult<{ email: string; password: string }> {
  const payload = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;

  if (typeof payload.email !== "string") {
    return { ok: false, error: "Email is required and must be a string." };
  }
  const email = normalizeEmail(payload.email);
  if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  if (typeof payload.password !== "string" || payload.password.length === 0) {
    return { ok: false, error: "Password is required." };
  }

  return { ok: true, data: { email, password: payload.password } };
}
