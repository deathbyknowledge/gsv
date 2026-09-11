import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccountRecoveryAttempt, redeemAccountRecovery, readHumanInvitationAttempt, redeemHumanInvitation } from "./accountRecovery";

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

  it("keeps human enrollment distinct from root recovery and retries the same receiver proof", async () => {
    window.history.replaceState(null, "", `/recover#id=${crypto.randomUUID()}&secret=${"a".repeat(64)}`);
    const recovery = readAccountRecoveryAttempt();
    window.history.replaceState(null, "", `/join#id=${crypto.randomUUID()}&secret=${"b".repeat(64)}`);
    const invitation = readHumanInvitationAttempt()!;
    expect(readAccountRecoveryAttempt()).toEqual(recovery);
    expect(window.location.hash).toBe("");
    const requestOnce = vi.fn().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValue({ uid: 1002, username: "member" });
    await expect(redeemHumanInvitation({ requestOnce }, "wss://space.example.com/ws", invitation, "member-password")).rejects.toThrow("lost reply");
    expect(readHumanInvitationAttempt()).toEqual(invitation);
    expect(await redeemHumanInvitation({ requestOnce }, "wss://space.example.com/ws", readHumanInvitationAttempt()!, "member-password")).toEqual({ uid: 1002, username: "member" });
    expect(requestOnce.mock.calls[0]).toEqual(requestOnce.mock.calls[1]);
    expect(requestOnce.mock.calls[0][1]).toBe("account.invite.redeem");
    expect(readHumanInvitationAttempt()).toBeNull();
    expect(readAccountRecoveryAttempt()).toEqual(recovery);
  });
});
