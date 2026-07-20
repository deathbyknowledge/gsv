export const ACCOUNT_USERNAME_MAX_CHARACTERS = 32;
export const ACCOUNT_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const ACCOUNT_USERNAME_INPUT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const ACCOUNT_USERNAME_INPUT_MAX_CHARACTERS = 64;

export const LOGIN_CREDENTIAL_MAX_CHARACTERS = 1024;
export const LOGIN_CREDENTIAL_MAX_BYTES = 2048;

const INVALID_CREDENTIAL_WORK_VALUE = "gsv-invalid-login-credential-work-v1";
const TEXT_ENCODER = new TextEncoder();

/**
 * Canonicalize public login input without doing unbounded string work.
 * Canonical usernames are a permanent routing and identity ABI. Validate the
 * raw, trimmed value as ASCII before folding ASCII capitals so Unicode case
 * mappings can never alias an existing account (for example, `K` must not
 * become `k`). A small raw-input ceiling keeps public parsing bounded while
 * still accepting ordinary surrounding whitespace from text fields.
 */
export function canonicalizeLoginUsername(value: unknown): string | null {
  if (typeof value !== "string" || value.length > ACCOUNT_USERNAME_INPUT_MAX_CHARACTERS) {
    return null;
  }
  const trimmed = value.trim();
  if (!ACCOUNT_USERNAME_INPUT_RE.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * Replace oversized public credentials with a fixed bounded value. Callers
 * still perform their normal dummy PBKDF2 or token-hash work, but must require
 * `valid` before accepting the result.
 */
export function loginCredentialWork(value: unknown): {
  value: string;
  valid: boolean;
} {
  if (typeof value !== "string" || value.length > LOGIN_CREDENTIAL_MAX_CHARACTERS) {
    return { value: INVALID_CREDENTIAL_WORK_VALUE, valid: false };
  }
  const byteLength = TEXT_ENCODER.encode(value).byteLength;
  if (byteLength > LOGIN_CREDENTIAL_MAX_BYTES) {
    return { value: INVALID_CREDENTIAL_WORK_VALUE, valid: false };
  }
  return { value, valid: true };
}
