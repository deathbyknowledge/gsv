export const ACCOUNT_USERNAME_MAX_CHARACTERS = 32;
export const ACCOUNT_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export const LOGIN_CREDENTIAL_MAX_CHARACTERS = 1024;
export const LOGIN_CREDENTIAL_MAX_BYTES = 2048;

const INVALID_CREDENTIAL_WORK_VALUE = "gsv-invalid-login-credential-work-v1";
const TEXT_ENCODER = new TextEncoder();

/**
 * Canonicalize public login input without doing unbounded string work.
 * Account aliases are lower-case ASCII and at most 32 characters. Short
 * casing and surrounding-whitespace variants resolve to that same alias;
 * inputs whose raw representation exceeds the account limit are malformed.
 */
export function canonicalizeLoginUsername(value: unknown): string | null {
  if (typeof value !== "string" || value.length > ACCOUNT_USERNAME_MAX_CHARACTERS) {
    return null;
  }
  const canonical = value.trim().toLowerCase();
  return ACCOUNT_USERNAME_RE.test(canonical) ? canonical : null;
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
