import { afterEach, describe, expect, it, vi } from "vitest";
import { createHumanInvitation } from "./peopleService";

describe("issuing human invitations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists authorization before minting and recovers the same link after a dropped reply", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", { location: { origin: "https://my-space.example.com" }, sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
    } });
    const create = vi.fn().mockImplementationOnce(async () => { expect(storage.size).toBe(1); throw new Error("lost reply"); }).mockResolvedValue({ status: "pending" });
    const client = { account: { invite: { create } } };
    await expect(createHumanInvitation(client, "member")).rejects.toThrow("lost reply");
    const url = new URL(await createHumanInvitation(client, "member"));
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(url.origin).toBe("https://my-space.example.com");
    expect(url.pathname).toBe("/join");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("secret")).toBe(create.mock.calls[0][0].secret);
    create.mockResolvedValue({ status: "redeemed" });
    await expect(createHumanInvitation(client, "member")).rejects.toThrow("ended");
    expect(storage.size).toBe(0);
  });
});
