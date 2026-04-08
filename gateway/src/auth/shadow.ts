/**
 * /etc/shadow parser and serializer.
 *
 * Format (one entry per line):
 *   username:hash:lastchanged:min:max:warn:inactive:expire:reserved
 *
 * We only use username and hash. The remaining fields are stored but
 * defaulted to empty — they exist so the format stays compatible with
 * standard tools and LLM expectations.
 *
 * Two credential schemes, distinguished by hash prefix:
 *
 *   $pbkdf2-sha512$<iterations>$<base64-salt>$<base64-hash>
 *     Salted, iterated KDF for human-memorable passwords.
 *
 *   $token-sha256$<hex-hash>
 *     Single-pass SHA-256 for high-entropy API tokens.
 *
 * An empty hash ("", "!", "*") means the account is locked.
 *
 * Example:
 *   root:$pbkdf2-sha512$100000$c2FsdA==$aGFzaA==:19800:0:99999:7:::
 *   bot:$token-sha256$abcdef0123456789...:19800:0:99999:7:::
 *   sam:!:19800:0:99999:7:::
 */

export type ShadowEntry = {
  username: string;
  hash: string;
  lastchanged: string;
  min: string;
  max: string;
  warn: string;
  inactive: string;
  expire: string;
  reserved: string;
};

export function parseShadow(raw: string): ShadowEntry[] {
  const entries: ShadowEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(":");
    if (parts.length < 2) continue;

    entries.push({
      username: parts[0],
      hash: parts[1] ?? "",
      lastchanged: parts[2] ?? "",
      min: parts[3] ?? "",
      max: parts[4] ?? "",
      warn: parts[5] ?? "",
      inactive: parts[6] ?? "",
      expire: parts[7] ?? "",
      reserved: parts[8] ?? "",
    });
  }
  return entries;
}

export function serializeShadow(entries: ShadowEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.username}:${e.hash}:${e.lastchanged}:${e.min}:${e.max}:${e.warn}:${e.inactive}:${e.expire}:${e.reserved}`,
    )
    .join("\n") + "\n";
}

export function findByUsername(
  entries: ShadowEntry[],
  username: string,
): ShadowEntry | undefined {
  return entries.find((e) => e.username === username);
}

export function isLocked(entry: ShadowEntry): boolean {
  return entry.hash === "" || entry.hash === "!" || entry.hash === "*";
}

export function makeShadowEntry(
  username: string,
  hash: string,
): ShadowEntry {
  const daysSinceEpoch = Math.floor(Date.now() / 86_400_000).toString();
  return {
    username,
    hash,
    lastchanged: daysSinceEpoch,
    min: "0",
    max: "99999",
    warn: "7",
    inactive: "",
    expire: "",
    reserved: "",
  };
}

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BITS = 512;

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(str: string): Uint8Array {
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Passwords — PBKDF2-SHA-512, salted + iterated
// ---------------------------------------------------------------------------

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer, iterations, hash: "SHA-512" },
    key,
    PBKDF2_HASH_BITS,
  );
  return `$pbkdf2-sha512$${iterations}$${toBase64(salt.buffer)}$${toBase64(derived)}`;
}

async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");
  // $pbkdf2-sha512$iterations$salt$hash → ["", "pbkdf2-sha512", iters, salt, hash]
  if (parts.length !== 5 || parts[1] !== "pbkdf2-sha512") return false;

  const iterations = parseInt(parts[2], 10);
  const salt = fromBase64(parts[3]);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-512" },
    key,
    PBKDF2_HASH_BITS,
  );

  const candidate = new Uint8Array(derived);
  const stored = fromBase64(parts[4]);
  if (candidate.length !== stored.length) return false;
  return crypto.subtle.timingSafeEqual(candidate, stored);
}

// ---------------------------------------------------------------------------
// Tokens — single-pass SHA-256 (sufficient for high-entropy secrets)
// ---------------------------------------------------------------------------

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return "$token-sha256$" + toHex(digest);
}

async function verifyTokenHash(
  token: string,
  storedHash: string,
): Promise<boolean> {
  const candidateHash = await hashToken(token);
  if (candidateHash.length !== storedHash.length) return false;
  const a = new TextEncoder().encode(candidateHash);
  const b = new TextEncoder().encode(storedHash);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Unified verify — dispatches based on hash prefix
// ---------------------------------------------------------------------------

export async function verify(
  credential: string,
  storedHash: string,
): Promise<boolean> {
  if (isLocked({ hash: storedHash } as ShadowEntry)) return false;

  if (storedHash.startsWith("$pbkdf2-sha512$")) {
    return verifyPassword(credential, storedHash);
  }
  if (storedHash.startsWith("$token-sha256$")) {
    return verifyTokenHash(credential, storedHash);
  }

  return false;
}
