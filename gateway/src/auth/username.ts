export const ACCOUNT_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const ACCOUNT_USERNAME_INPUT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const ACCOUNT_USERNAME_INPUT_MAX_LENGTH = 64;

/** Normalize a public username only after proving the input is bounded ASCII. */
export function normalizeAccountUsername(value: unknown): string | null {
  if (typeof value !== "string" || value.length > ACCOUNT_USERNAME_INPUT_MAX_LENGTH) return null;
  const input = value.trim();
  if (!ACCOUNT_USERNAME_INPUT_RE.test(input)) return null;
  return input.toLowerCase();
}
