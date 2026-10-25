import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { PasswordAttempts, passwordWaitMessage, SIGN_IN_PACING } from "./password-attempts";

const MINUTE = 60_000;

/** Attempts over a Kernel's real storage, on a clock the test moves. */
async function withAttempts(work: (attempts: PasswordAttempts, clock: { now: number }, kv: SyncKvStorage) => Promise<void> | void) {
  await runWithRealKernelSql(async (_sql, storage) => {
    const clock = { now: Date.UTC(2026, 9, 25, 12) };
    await work(new PasswordAttempts(storage.kv, "sign-in", SIGN_IN_PACING, () => clock.now), clock, storage.kv);
  });
}

/** Begins an attempt and settles it as the password turned out, returning the wait when it was refused. */
function attempt(attempts: PasswordAttempts, account: string | null, source: string | null, valid = false): number | null {
  const begun = attempts.begin(account, source);
  if (!begun.allowed) return begun.waitMs;
  begun.settle(valid);
  return null;
}

describe("password attempts", () => {
  it("waits after five wrong passwords in a row, doubling with each wrong one after, up to fifteen minutes", async () => {
    await withAttempts((attempts, clock) => {
      for (let count = 0; count < 5; count++) expect(attempt(attempts, "1000", null)).toBeNull();
      const waits: number[] = [];
      for (let count = 0; count < 8; count++) {
        const waitMs = attempt(attempts, "1000", null)!;
        waits.push(waitMs);
        clock.now += waitMs;
        // Once the wait is over, the next password is checked, and a wrong one doubles the wait.
        expect(attempt(attempts, "1000", null)).toBeNull();
      }
      expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 15 * MINUTE, 15 * MINUTE, 15 * MINUTE]);
    });
  });

  it("refuses a right password during a wait without checking it, and forgives the run once one is right", async () => {
    await withAttempts((attempts, clock) => {
      for (let count = 0; count < 5; count++) attempt(attempts, "1000", null);
      // A refused attempt never reaches its check, so it can't be settled either way.
      expect(attempts.begin("1000", null)).toEqual({ allowed: false, waitMs: 30_000 });
      clock.now += 30_000;
      expect(attempt(attempts, "1000", null, true)).toBeNull();
      for (let count = 0; count < 5; count++) expect(attempt(attempts, "1000", null)).toBeNull();
      expect(attempt(attempts, "1000", null)).toBe(30_000);
    });
  });

  it("keeps each address's run to itself, so an address that waits never delays another", async () => {
    await withAttempts((attempts) => {
      for (let count = 0; count < 5; count++) attempt(attempts, "1000", "address-a");
      expect(attempt(attempts, "1000", "address-a", true)).toBe(30_000);
      expect(attempt(attempts, "1000", "address-b", true)).toBeNull();
      // The right password from another address forgives only that address's run.
      expect(attempt(attempts, "1000", "address-a", true)).toBe(30_000);
    });
  });

  it("forgets a run fifteen minutes after its last wrong password", async () => {
    await withAttempts((attempts, clock) => {
      for (let count = 0; count < 4; count++) attempt(attempts, "1000", null);
      clock.now += 15 * MINUTE + 1;
      for (let count = 0; count < 4; count++) expect(attempt(attempts, "1000", null)).toBeNull();
      expect(attempt(attempts, "1000", null)).toBeNull();
      expect(attempt(attempts, "1000", null)).toBe(30_000);
    });
  });

  it("counts an attempt before its password is checked, so attempts made at once can't get past the limit", async () => {
    await withAttempts((attempts) => {
      const pending = Array.from({ length: 5 }, () => attempts.begin("1000", null));
      expect(pending.every((begun) => begun.allowed)).toBe(true);
      expect(attempts.begin("1000", null)).toEqual({ allowed: false, waitMs: 30_000 });
    });
  });

  it("gives one address twenty wrong passwords an hour across every account, unknown ones included", async () => {
    await withAttempts((attempts, clock) => {
      // Four each for root and the person, so neither account's own run reaches five, and twelve for names that aren't accounts.
      const accounts = [...Array<string>(4).fill("0"), ...Array<string>(4).fill("1000"), ...Array<null>(12).fill(null)];
      for (const account of accounts) {
        expect(attempt(attempts, account, "address-a")).toBeNull();
        clock.now += 1_000;
      }
      expect(attempt(attempts, "1000", "address-a", true)).toBe(60 * MINUTE - 20_000);
      expect(attempt(attempts, "1000", "address-b", true)).toBeNull();
      clock.now += 60 * MINUTE - 20_000;
      expect(attempt(attempts, "0", "address-a")).toBeNull();
    });
  });

  it("gives one account a hundred wrong passwords an hour across every address", async () => {
    await withAttempts((attempts, clock) => {
      // Five from each of twenty addresses, so no address's own run or count stops them.
      for (let address = 0; address < 20; address++) {
        for (let count = 0; count < 5; count++) {
          expect(attempt(attempts, "1000", `address-${address}`)).toBeNull();
          clock.now += 1_000;
        }
      }
      // The next waits, even with the right password, until the hour frees a slot.
      expect(attempt(attempts, "1000", "address-new", true)).toBe(60 * MINUTE - 100_000);
      expect(attempt(attempts, "0", "address-new", true)).toBeNull();
      clock.now += 60 * MINUTE - 100_000;
      expect(attempt(attempts, "1000", "address-new", true)).toBeNull();
    });
  });

  it("takes back a right password's count from its account and address", async () => {
    await withAttempts((attempts) => {
      for (let count = 0; count < 120; count++) expect(attempt(attempts, "1000", "address-a", true)).toBeNull();
    });
  });

  it("keeps an address only as a hash keyed to the Kernel", async () => {
    let first: string | null = null;
    await withAttempts(async (attempts, _clock, kv) => {
      first = await attempts.source("203.0.113.7");
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(await attempts.source(" 203.0.113.7 ")).toBe(first);
      expect(await attempts.source("203.0.113.8")).not.toBe(first);
      expect(await attempts.source(null)).toBeNull();
      expect(await attempts.source("")).toBeNull();
      attempt(attempts, "1000", first);
      const stored = JSON.stringify([...kv.list()]);
      expect(stored).not.toContain("203.0.113.7");
    });
    await withAttempts(async (attempts) => {
      expect(await attempts.source("203.0.113.7")).not.toBe(first);
    });
  });

  it("counts addresses in one IPv6 /64 as one address", async () => {
    await withAttempts(async (attempts) => {
      const first = await attempts.source("2001:db8:1:2::a");
      const second = await attempts.source("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff");
      expect(second).toBe(first);
      expect(await attempts.source("2001:db8:1:3::a")).not.toBe(first);
      for (let count = 0; count < 10; count++) attempt(attempts, null, first);
      for (let count = 0; count < 10; count++) attempt(attempts, null, second);
      expect(attempt(attempts, null, await attempts.source("2001:db8:1:2::c"))).toBe(60 * MINUTE);
    });
  });

  it("counts an IPv4-mapped IPv6 address as its IPv4 address, and IPv4 exactly", async () => {
    await withAttempts(async (attempts) => {
      const ipv4 = await attempts.source("203.0.113.7");
      expect(await attempts.source("::ffff:203.0.113.7")).toBe(ipv4);
      expect(await attempts.source("::FFFF:cb00:7107")).toBe(ipv4);
      expect(await attempts.source("203.0.113.8")).not.toBe(ipv4);
    });
  });

  it("sweeps away records that no longer matter as attempts arrive", async () => {
    await withAttempts((attempts, clock, kv) => {
      for (let count = 0; count < 12; count++) attempt(attempts, `${2000 + count}`, `address-${count}`);
      clock.now += 61 * MINUTE;
      for (let count = 0; count < 5; count++) attempt(attempts, "1000", "address-live");
      const left = [...kv.list({ prefix: "sign-in:" })].map(([key]) => key).filter((key) => key !== "sign-in:sweep");
      expect(left.length).toBeGreaterThan(0);
      expect(left.filter((key) => !key.includes(":1000") && !key.endsWith(":address-live"))).toEqual([]);
    });
  });

  it("tells a person how long to wait in whole minutes", () => {
    expect(passwordWaitMessage(30_000)).toBe("Too many sign-in attempts. Try again in 1 minute.");
    expect(passwordWaitMessage(61_000)).toBe("Too many sign-in attempts. Try again in 2 minutes.");
    expect(passwordWaitMessage(15 * MINUTE)).toBe("Too many sign-in attempts. Try again in 15 minutes.");
  });
});
