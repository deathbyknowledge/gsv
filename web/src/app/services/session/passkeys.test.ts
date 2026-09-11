import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrollPasskey, signInWithPasskey } from "./passkeys";

const browser = { register: vi.fn(), authenticate: vi.fn() };

describe("browser passkeys", () => {
  beforeEach(() => { browser.register.mockReset(); browser.authenticate.mockReset(); });

  it("enrolls only the Kernel's challenge and response without supplying a local uid", async () => {
    const begin = vi.fn().mockResolvedValue({ id: "kernel-attempt", options: { challenge: "kernel-challenge" } });
    const finish = vi.fn().mockResolvedValue({ id: "credential", label: "Laptop", createdAt: 1, lastUsedAt: null });
    const response = { id: "credential", response: { attestationObject: "signed-attestation" } };
    browser.register.mockResolvedValue(response);
    expect(await enrollPasskey({ account: { passkey: { register: { begin, finish } } } }, "Laptop", browser)).toMatchObject({ id: "credential" });
    expect(begin).toHaveBeenCalledWith({ label: "Laptop" });
    expect(browser.register).toHaveBeenCalledWith({ optionsJSON: { challenge: "kernel-challenge" } });
    expect(finish).toHaveBeenCalledWith({ id: "kernel-attempt", response });
  });

  it("enters the existing session path only with a verified Kernel token", async () => {
    const response = { id: "credential", response: { signature: "signature" } };
    browser.authenticate.mockResolvedValue(response);
    const requestOnce = vi.fn().mockResolvedValueOnce({ id: "attempt", options: { challenge: "challenge" } }).mockResolvedValueOnce({ username: "verified-person", token: "verified-token" });
    const login = vi.fn().mockResolvedValue({});
    const snapshot = vi.fn().mockReturnValue({ url: "wss://space.example.com/ws" });
    await signInWithPasskey({ client: { requestOnce }, login, snapshot }, "person", browser);
    expect(requestOnce.mock.calls).toEqual([
      ["wss://space.example.com/ws", "account.passkey.authenticate.begin", { username: "person" }],
      ["wss://space.example.com/ws", "account.passkey.authenticate.finish", { id: "attempt", response }],
    ]);
    expect(login).toHaveBeenCalledWith({ username: "verified-person", token: "verified-token" });
  });

  it("does not issue credentials or change the session after a cancelled authenticator prompt", async () => {
    browser.authenticate.mockRejectedValue(new Error("cancelled"));
    const requestOnce = vi.fn().mockResolvedValue({ id: "attempt", options: { challenge: "challenge" } });
    const login = vi.fn();
    const snapshot = vi.fn().mockReturnValue({ url: "wss://space.example.com/ws" });
    await expect(signInWithPasskey({ client: { requestOnce }, login, snapshot }, "person", browser)).rejects.toThrow("cancelled");
    expect(requestOnce).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });
});
