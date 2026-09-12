import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemberRecoveryAttempt, readMemberRecoveryAttempt, redeemMemberRecovery, startMemberRecovery } from "./memberRecovery";

describe("member recovery browser ownership", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists the same browser proof across lost start and redeem responses without storing passwords or codes", async () => {
    const attempt = createMemberRecoveryAttempt(" Member ");
    const requestOnce = vi.fn().mockImplementationOnce(async () => {
      expect(readMemberRecoveryAttempt()).toEqual(attempt);
      throw new Error("lost start response");
    }).mockResolvedValueOnce({ accepted: true }).mockRejectedValueOnce(new Error("lost redeem response")).mockResolvedValueOnce({ username: "member" });
    await expect(startMemberRecovery({ requestOnce }, "wss://space.example/ws", attempt)).rejects.toThrow("lost start");
    await startMemberRecovery({ requestOnce }, "wss://space.example/ws", readMemberRecoveryAttempt()!);
    expect(requestOnce.mock.calls[0]).toEqual(requestOnce.mock.calls[1]);
    await expect(redeemMemberRecovery({ requestOnce }, "wss://space.example/ws", attempt, "ABCD-EF12", " password with spaces ")).rejects.toThrow("lost redeem");
    expect(readMemberRecoveryAttempt()).toEqual(attempt);
    expect(await redeemMemberRecovery({ requestOnce }, "wss://space.example/ws", readMemberRecoveryAttempt()!, "ABCD-EF12", " password with spaces ")).toBe("member");
    expect(requestOnce.mock.calls[2]).toEqual(requestOnce.mock.calls[3]);
    expect(requestOnce.mock.calls[2][2].password).toBe(" password with spaces ");
    expect(readMemberRecoveryAttempt()).toBeNull();
  });

  it("requires durable storage before starting and gives a fresh attempt separate ownership", () => {
    const first = createMemberRecoveryAttempt("member");
    expect(createMemberRecoveryAttempt("member")).toEqual(first);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const renewed = createMemberRecoveryAttempt("member");
    clock.mockRestore();
    expect(renewed.id).not.toBe(first.id);
    const second = createMemberRecoveryAttempt("another");
    expect(second.id).not.toBe(first.id);
    expect(second.proof).not.toBe(first.proof);
    expect(readMemberRecoveryAttempt()).toEqual(second);
    vi.spyOn(window.sessionStorage, "setItem").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    expect(() => createMemberRecoveryAttempt("different")).toThrow("storage unavailable");
    expect(readMemberRecoveryAttempt()).toEqual(second);
  });
});
