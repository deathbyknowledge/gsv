export const ACCOUNT_SESSION_COOKIE = "__Host-gsv-account-session";

export function readAccountSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== ACCOUNT_SESSION_COOKIE) continue;
    const encoded = part.slice(separator + 1).trim();
    if (!encoded || encoded.length > 512) return null;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return null;
    }
  }
  return null;
}

export function accountSessionSetCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearAccountSessionCookie(): string {
  return `${ACCOUNT_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}
