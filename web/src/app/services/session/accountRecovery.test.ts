import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPersonalAccountUnavailable, readAccountRecoveryAttempt, readRecoveryOptions, redeemAccountRecovery } from "./accountRecovery";

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
    await expect(redeemAccountRecovery({ requestOnce }, "wss://space.example.com/ws", attempt, "new-password", "administrator")).rejects.toThrow("lost response");
    const reloaded = readAccountRecoveryAttempt()!;
    await redeemAccountRecovery({ requestOnce }, "wss://space.example.com/ws", reloaded, "new-password", "administrator");
    expect(requestOnce.mock.calls[0]).toEqual(requestOnce.mock.calls[1]);
    expect(readAccountRecoveryAttempt()).toBeNull();
  });

  it("keeps the chosen account with the proof so a retry after a lost reply is the same request", async () => {
    window.history.replaceState(null, "", `/recover#id=${crypto.randomUUID()}&secret=${"s".repeat(43)}`);
    const attempt = readAccountRecoveryAttempt()!;
    const requestOnce = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValue({ username: "person" });
    await expect(redeemAccountRecovery({ requestOnce }, "wss://space.example.com/ws", attempt, "new-password", "administrator")).rejects.toThrow("lost response");
    const reloaded = readAccountRecoveryAttempt()!;
    expect(reloaded.account).toBe("administrator");
    await redeemAccountRecovery({ requestOnce }, "wss://space.example.com/ws", reloaded, "new-password", reloaded.account ?? "personal");
    expect(requestOnce.mock.calls[1]).toEqual(requestOnce.mock.calls[0]);
    expect(requestOnce.mock.calls[0][2]).toMatchObject({ account: "administrator", password: "new-password" });
  });

  it("recognizes the Kernel's answer for an unavailable personal account", () => {
    expect(isPersonalAccountUnavailable(Object.assign(new Error("failed"), { details: { recovery: "personal-unavailable" } }))).toBe(true);
    expect(isPersonalAccountUnavailable(new Error("other"))).toBe(false);
  });

  it("reads the owner page link and treats any failure as no email option", async () => {
    const url = "https://accounts.example/owner/recover?handle=my-ship";
    expect(await readRecoveryOptions({ requestOnce: vi.fn().mockResolvedValue({ emailUrl: url }) }, "wss://space.example.com/ws")).toEqual({ emailUrl: url });
    expect(await readRecoveryOptions({ requestOnce: vi.fn().mockRejectedValue(new Error("older Kernel")) }, "wss://space.example.com/ws")).toEqual({});
    expect(await readRecoveryOptions({ requestOnce: vi.fn().mockResolvedValue({ emailUrl: "javascript:alert(1)" }) }, "wss://space.example.com/ws")).toEqual({});
  });

  it("does not start recovery without durable recipient storage", () => {
    window.history.replaceState(null, "", `/recover#id=${crypto.randomUUID()}&secret=${"s".repeat(43)}`);
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    expect(() => readAccountRecoveryAttempt()).toThrow("storage unavailable");
  });

});
