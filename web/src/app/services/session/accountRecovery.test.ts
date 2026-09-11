import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccountRecoveryAttempt, redeemAccountRecovery } from "./accountRecovery";

describe("root recovery receipt ownership", () => {
  beforeEach(() => {
    let location = new URL("https://space.example.com/recover");
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      get location() { return location; },
      history: { state: null, replaceState<T>(_state: T, _unused: string, url: string) { location = new URL(url, location); } },
      sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists a recipient proof before redemption and retries it after a lost response", async () => {
    const id = crypto.randomUUID();
    window.history.replaceState(null, "", `/recover#id=${id}&secret=${"s".repeat(43)}`);
    const attempt = readAccountRecoveryAttempt()!;
    expect(attempt.id).toBe(id);
    expect(attempt.proof.length).toBeGreaterThanOrEqual(32);
    expect(window.location.hash).toBe("");
    expect(readAccountRecoveryAttempt()).toEqual(attempt);
    const requestOnce = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValue({ username: "root" });
    await expect(redeemAccountRecovery({ requestOnce }, "wss://space.example.com/ws", attempt, "new-password")).rejects.toThrow("lost response");
    const reloaded = readAccountRecoveryAttempt()!;
    await redeemAccountRecovery({ requestOnce }, "wss://space.example.com/ws", reloaded, "new-password");
    expect(requestOnce.mock.calls[0]).toEqual(requestOnce.mock.calls[1]);
    expect(readAccountRecoveryAttempt()).toBeNull();
  });

  it("does not start recovery without durable recipient storage", () => {
    window.history.replaceState(null, "", `/recover#id=${crypto.randomUUID()}&secret=${"s".repeat(43)}`);
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(() => readAccountRecoveryAttempt()).toThrow("storage unavailable");
  });
});
