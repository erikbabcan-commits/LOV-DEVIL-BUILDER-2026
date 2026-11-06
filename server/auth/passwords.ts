import bcrypt from 'bcryptjs';

/* WS-1 heslá — bcrypt (cost 10), server-only. */

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export function isStrongEnoughPassword(password: string): boolean {
  return password.length >= 8 && password.length <= 128;
}
