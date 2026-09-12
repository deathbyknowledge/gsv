import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOwnerLink } from "./ownerLink";

const storageKey = "gsv.ui.owner-link.v1";
const now = Date.UTC(2026, 8, 12);

describe("owner linking browser retries", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } });
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("saves before dispatch and retries the same proof after a lost response until success", async () => {
    const link = vi.fn().mockImplementationOnce(async (attempt: { id: string; secret: string }) => {
      expect(JSON.parse(window.sessionStorage.getItem(storageKey)!)).toEqual({ ...attempt, createdAt: now });
      expect(Object.keys(attempt).sort()).toEqual(["id", "secret"]);
      throw new Error("lost response");
    }).mockResolvedValue({ url: "https://accounts.example/owner/link#fixture", expiresAt: now + 600_000 });
    const client = { account: { owner: { link } } };
    await expect(startOwnerLink(client)).rejects.toThrow("lost response");
    vi.mocked(Date.now).mockReturnValue(now + 599_999);
    expect(await startOwnerLink(client)).toBe("https://accounts.example/owner/link#fixture");
    expect(link.mock.calls[1]).toEqual(link.mock.calls[0]);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it.each([600_000, 600_001])("replaces a failed attempt after %i ms without renewing its retry window", async (elapsed) => {
    const link = vi.fn().mockRejectedValue(new Error("lost response"));
    const client = { account: { owner: { link } } };
    await expect(startOwnerLink(client)).rejects.toThrow("lost response");
    const original = window.sessionStorage.getItem(storageKey);
    vi.mocked(Date.now).mockReturnValue(now + 300_000);
    await expect(startOwnerLink(client)).rejects.toThrow("lost response");
    expect(window.sessionStorage.getItem(storageKey)).toBe(original);
    vi.mocked(Date.now).mockReturnValue(now + elapsed);
    await expect(startOwnerLink(client)).rejects.toThrow("lost response");
    expect(link.mock.calls[2][0].id).not.toBe(link.mock.calls[0][0].id);
    expect(link.mock.calls[2][0].secret).not.toBe(link.mock.calls[0][0].secret);
    expect(JSON.parse(window.sessionStorage.getItem(storageKey)!)).toEqual({ ...link.mock.calls[2][0], createdAt: now + elapsed });
  });

  it.each([
    ["malformed", "{"],
    ["legacy", JSON.stringify({ id: "ec5467cf-d479-48af-9007-12e7e95f50da", secret: "a".repeat(64) })],
    ["future", JSON.stringify({ id: "ec5467cf-d479-48af-9007-12e7e95f50da", secret: "a".repeat(64), createdAt: now + 1 })],
  ])("replaces %s cached attempts", async (_label, saved) => {
    window.sessionStorage.setItem(storageKey, saved);
    const link = vi.fn().mockResolvedValue({ url: "https://accounts.example/owner/link", expiresAt: now + 600_000 });
    await startOwnerLink({ account: { owner: { link } } });
    expect(link.mock.calls[0][0]).toEqual({ id: expect.any(String), secret: expect.any(String) });
    expect(link.mock.calls[0][0].id).not.toBe("ec5467cf-d479-48af-9007-12e7e95f50da");
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("does not dispatch without first saving the retry proof", async () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    const link = vi.fn();
    await expect(startOwnerLink({ account: { owner: { link } } })).rejects.toThrow("storage unavailable");
    expect(link).not.toHaveBeenCalled();
  });
});
