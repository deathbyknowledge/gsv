/**
 * How quickly wrong passwords are answered. Each account allows a few wrong
 * passwords in a row, then waits before the next one is checked, and each
 * wrong one after that doubles the wait. One client address gets only so many
 * wrong passwords an hour across every account.
 */
export type PasswordPacing = {
  /** Wrong passwords in a row an account gets before it waits. */
  freeFailures: number;
  /** The first wait; every wrong password after it doubles the wait. */
  firstWaitMs: number;
  maxWaitMs: number;
  /** How long after an account's last wrong password, or the end of its wait, its run is forgotten. */
  forgetAfterMs: number;
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
  perSource: 20,
  windowMs: 60 * 60_000,
};

/** Either the password may be checked, and the result settles the attempt, or the attempt waits unchecked. */
export type PasswordAttempt =
  | { allowed: true; settle(valid: boolean): void }
  | { allowed: false; waitMs: number };

type AccountRun = { failures: number; waitUntil: number; at: number };
type SourceLog = { at: number[] };

/** The secret that keys address hashes, shared by every scope. */
const SOURCE_KEY = "password-attempts:key";
/** Records the sweep looks at on each counted attempt. */
const SWEEP_BATCH = 10;

/**
 * Counts wrong passwords in Durable Object storage. An attempt counts as wrong
 * before its password is checked, and a right password then takes it back, so
 * attempts made at the same time can't get past a limit. While a wait applies,
 * no password is checked at all. Addresses are kept only as keyed hashes, and
 * records that no longer matter are swept away as attempts arrive.
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
    const mac = await crypto.subtle.sign("HMAC", await this.sourceKey(), new TextEncoder().encode(value));
    return Array.from(new Uint8Array(mac).subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Counts an attempt for an account, named by a stable id, and for the source
   * it came from, unless either must wait. An unknown account counts only for
   * its source.
   */
  begin(account: string | null, source: string | null): PasswordAttempt {
    const now = this.now();
    const accountKey = account === null ? null : `${this.scope}:account:${account}`;
    const sourceKey = source === null ? null : `${this.scope}:source:${source}`;
    const stored = accountKey ? this.kv.get<AccountRun>(accountKey) : undefined;
    const run = stored && !this.forgotten(stored, now) ? stored : undefined;
    const log = sourceKey ? this.recent(this.kv.get<SourceLog>(sourceKey), now) : [];
    const waitMs = Math.max(
      run && run.waitUntil > now ? run.waitUntil - now : 0,
      log.length >= this.pacing.perSource ? log[0]! + this.pacing.windowMs - now : 0,
    );
    if (waitMs > 0) return { allowed: false, waitMs };

    const failures = (run?.failures ?? 0) + 1;
    const extra = failures - this.pacing.freeFailures;
    const waitUntil = extra >= 0 ? now + Math.min(this.pacing.firstWaitMs * 2 ** extra, this.pacing.maxWaitMs) : 0;
    if (accountKey) this.kv.put(accountKey, { failures, waitUntil, at: now } satisfies AccountRun);
    if (sourceKey) this.kv.put(sourceKey, { at: [...log, now] } satisfies SourceLog);
    this.sweep(now);
    return {
      allowed: true,
      settle: (valid) => {
        if (!valid) return;
        if (accountKey) this.kv.delete(accountKey);
        if (!sourceKey) return;
        const remaining = this.recent(this.kv.get<SourceLog>(sourceKey), this.now());
        const index = remaining.lastIndexOf(now);
        if (index >= 0) remaining.splice(index, 1);
        if (remaining.length > 0) this.kv.put(sourceKey, { at: remaining } satisfies SourceLog);
        else this.kv.delete(sourceKey);
      },
    };
  }

  private forgotten(run: AccountRun, now: number): boolean {
    return now - Math.max(run.at, run.waitUntil) > this.pacing.forgetAfterMs;
  }

  private recent(log: SourceLog | undefined, now: number): number[] {
    return (log?.at ?? []).filter((at) => now - at < this.pacing.windowMs);
  }

  /** Deletes the scope's records that no longer matter, a few at a time from where the last sweep stopped. */
  private sweep(now: number): void {
    const cursorKey = `${this.scope}:sweep`;
    const after = this.kv.get<string>(cursorKey);
    const options: SyncKvListOptions = { prefix: `${this.scope}:`, limit: SWEEP_BATCH };
    if (after) options.startAfter = after;
    const batch = [...this.kv.list<AccountRun | SourceLog | string>(options)];
    for (const [key, value] of batch) {
      // SAFETY: the scope writes only runs under its account keys and logs under its source keys.
      const stale = key.startsWith(`${this.scope}:account:`) ? this.forgotten(value as AccountRun, now)
        : key.startsWith(`${this.scope}:source:`) && this.recent(value as SourceLog, now).length === 0;
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

/** What a person is told while an attempt waits, the same whether or not the password was right. */
export function passwordWaitMessage(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
