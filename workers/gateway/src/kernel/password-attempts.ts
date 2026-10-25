/**
 * How quickly wrong passwords are answered. From each address, an account
 * allows a few wrong passwords in a row, then waits before the next one is
 * checked, and each wrong one after that doubles the wait. One account gets
 * only so many wrong passwords an hour across every address, and one address
 * only so many across every account.
 */
export type PasswordPacing = {
  /** Wrong passwords in a row an account gets from one address before that address waits. */
  freeFailures: number;
  /** The first wait; every wrong password after it doubles the wait. */
  firstWaitMs: number;
  maxWaitMs: number;
  /** How long after a run's last wrong password, or the end of its wait, the run is forgotten. */
  forgetAfterMs: number;
  /** Wrong passwords one account gets within `windowMs`, across every address. */
  perAccount: number;
  /** Wrong passwords one address gets within `windowMs`, across every account. */
  perSource: number;
  windowMs: number;
};

/** Signing in to a Ship with a password. */
export const SIGN_IN_PACING: PasswordPacing = {
  freeFailures: 5,
  firstWaitMs: 30_000,
  maxWaitMs: 15 * 60_000,
  forgetAfterMs: 15 * 60_000,
  perAccount: 100,
  perSource: 20,
  windowMs: 60 * 60_000,
};

/** Either the password may be checked, and the result settles the attempt, or the attempt waits unchecked. */
export type PasswordAttempt =
  | { allowed: true; settle(valid: boolean): void }
  | { allowed: false; waitMs: number };

/** Wrong passwords in a row for one account from one address. */
type Run = { failures: number; waitUntil: number; at: number };
/** When the wrong passwords counted within the window were made, oldest first. */
type AttemptLog = { at: number[] };

/** The secret that keys address hashes, shared by every scope. */
const SOURCE_KEY = "password-attempts:key";
/** Records the sweep looks at on each counted attempt. */
const SWEEP_BATCH = 10;

/**
 * Counts wrong passwords in Durable Object storage. An attempt counts as wrong
 * before its password is checked, and a right password then takes it back, so
 * attempts made at the same time can't get past a limit. While a wait applies,
 * no password is checked at all. Addresses are kept only as keyed hashes of
 * the part one client holds, and records that no longer matter are swept away
 * as attempts arrive.
 */
export class PasswordAttempts {
  private hmac: Promise<CryptoKey> | null = null;

  constructor(
    private readonly kv: SyncKvStorage,
    private readonly scope = "sign-in",
    private readonly pacing: PasswordPacing = SIGN_IN_PACING,
    private readonly now: () => number = Date.now,
  ) {}

  /** The keyed hash under which an address is counted, or null when the request names none. */
  async source(address: string | null | undefined): Promise<string | null> {
    const value = address?.trim();
    if (!value) return null;
    const mac = await crypto.subtle.sign("HMAC", await this.sourceKey(), new TextEncoder().encode(clientPart(value)));
    return Array.from(new Uint8Array(mac).subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Counts an attempt for an account, named by a stable id, and for the source
   * it came from, unless any count must wait. An unknown account counts only
   * for its source.
   */
  begin(account: string | null, source: string | null): PasswordAttempt {
    const now = this.now();
    const runKey = account === null ? null : `${this.scope}:run:${account}:${source ?? "unknown"}`;
    const accountKey = account === null ? null : `${this.scope}:account:${account}`;
    const sourceKey = source === null ? null : `${this.scope}:source:${source}`;
    const stored = runKey ? this.kv.get<Run>(runKey) : undefined;
    const run = stored && !this.forgotten(stored, now) ? stored : undefined;
    const accountLog = accountKey ? this.recent(this.kv.get<AttemptLog>(accountKey), now) : [];
    const sourceLog = sourceKey ? this.recent(this.kv.get<AttemptLog>(sourceKey), now) : [];
    const waitMs = Math.max(
      run && run.waitUntil > now ? run.waitUntil - now : 0,
      this.windowWait(accountLog, this.pacing.perAccount, now),
      this.windowWait(sourceLog, this.pacing.perSource, now),
    );
    if (waitMs > 0) return { allowed: false, waitMs };

    const failures = (run?.failures ?? 0) + 1;
    const extra = failures - this.pacing.freeFailures;
    const waitUntil = extra >= 0 ? now + Math.min(this.pacing.firstWaitMs * 2 ** extra, this.pacing.maxWaitMs) : 0;
    if (runKey) this.kv.put(runKey, { failures, waitUntil, at: now } satisfies Run);
    if (accountKey) this.kv.put(accountKey, { at: [...accountLog, now] } satisfies AttemptLog);
    if (sourceKey) this.kv.put(sourceKey, { at: [...sourceLog, now] } satisfies AttemptLog);
    this.sweep(now);
    return {
      allowed: true,
      settle: (valid) => {
        if (!valid) return;
        if (runKey) this.kv.delete(runKey);
        if (accountKey) this.takeBack(accountKey, now);
        if (sourceKey) this.takeBack(sourceKey, now);
      },
    };
  }

  private forgotten(run: Run, now: number): boolean {
    return now - Math.max(run.at, run.waitUntil) > this.pacing.forgetAfterMs;
  }

  private recent(log: AttemptLog | undefined, now: number): number[] {
    return (log?.at ?? []).filter((at) => now - at < this.pacing.windowMs);
  }

  /** How long a full window waits until its oldest attempt leaves it and frees a slot. */
  private windowWait(log: number[], limit: number, now: number): number {
    return log.length >= limit ? log[0]! + this.pacing.windowMs - now : 0;
  }

  /** Removes a right password's attempt, counted at `at`, from a log. */
  private takeBack(key: string, at: number): void {
    const log = this.recent(this.kv.get<AttemptLog>(key), this.now());
    const index = log.lastIndexOf(at);
    if (index >= 0) log.splice(index, 1);
    if (log.length > 0) this.kv.put(key, { at: log } satisfies AttemptLog);
    else this.kv.delete(key);
  }

  /** Deletes the scope's records that no longer matter, a few at a time from where the last sweep stopped. */
  private sweep(now: number): void {
    const cursorKey = `${this.scope}:sweep`;
    const after = this.kv.get<string>(cursorKey);
    const options: SyncKvListOptions = { prefix: `${this.scope}:`, limit: SWEEP_BATCH };
    if (after) options.startAfter = after;
    const batch = [...this.kv.list<Run | AttemptLog | string>(options)];
    for (const [key, value] of batch) {
      // SAFETY: the scope writes runs only under its run keys, and logs only under its account and source keys.
      const stale = key.startsWith(`${this.scope}:run:`) ? this.forgotten(value as Run, now)
        : (key.startsWith(`${this.scope}:account:`) || key.startsWith(`${this.scope}:source:`))
          && this.recent(value as AttemptLog, now).length === 0;
      if (stale) this.kv.delete(key);
    }
    const last = batch.at(-1)?.[0];
    if (batch.length < SWEEP_BATCH || !last) this.kv.delete(cursorKey);
    else this.kv.put(cursorKey, last);
  }

  private sourceKey(): Promise<CryptoKey> {
    this.hmac ??= (() => {
      let secret = this.kv.get<string>(SOURCE_KEY);
      if (!secret) {
        secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
        this.kv.put(SOURCE_KEY, secret);
      }
      const bytes = Uint8Array.from(secret.match(/../g)!, (pair) => Number.parseInt(pair, 16));
      return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    return this.hmac;
  }
}

/**
 * The part of an address that one client is taken to hold: an IPv4 address
 * exactly, or an IPv6 address's /64. An IPv4-mapped IPv6 address is its IPv4
 * address.
 */
function clientPart(address: string): string {
  if (!address.includes(":")) return address;
  let host: string;
  try {
    // The URL parser checks the address and writes it in one canonical form.
    host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return address;
  }
  const [head = "", tail] = host.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back];
  if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
    const high = Number.parseInt(groups[6]!, 16);
    const low = Number.parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** What a person is told while an attempt waits, the same whether or not the password was right. */
export function passwordWaitMessage(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
