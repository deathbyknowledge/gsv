import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicRepositoryAccount } from "@humansandmachines/gsv/services/pds";
import { serveAtprotoDid } from "./atproto-did";

const INSTALLATION_ID = "inst_ada";
const ACCOUNT = { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "ada.ship.space" };

function fixture(account: () => Promise<PublicRepositoryAccount | null>) {
  const dispose = vi.fn();
  const getInstallation = vi.fn(async () => ({ account, [Symbol.dispose]: dispose }));
  // SAFETY: The route reads only the repository's account.
  return { pds: { getInstallation } as never, getInstallation, dispose };
}

function resolve(url: string, pds: ReturnType<typeof fixture>["pds"] | undefined, method = "GET") {
  return serveAtprotoDid(new Request(url, { method }), pds, INSTALLATION_ID);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ATProto handle resolution", () => {
  it("answers with the DID whose account names the requested hostname", async () => {
    const f = fixture(async () => ACCOUNT);
    const response = await resolve("https://ada.ship.space/.well-known/atproto-did", f.pds);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ACCOUNT.did);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(f.getInstallation).toHaveBeenCalledWith(INSTALLATION_ID);
    expect(f.dispose).toHaveBeenCalledOnce();

    const head = await resolve("https://ADA.ship.space/.well-known/atproto-did", f.pds, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("claims no handle the account does not name", async () => {
    const elsewhere = fixture(async () => ({ ...ACCOUNT, handle: "ada.gsv.space" }));
    const unpublished = fixture(async () => null);
    for (const pds of [elsewhere.pds, unpublished.pds, undefined]) {
      const response = await resolve("https://ada.ship.space/.well-known/atproto-did", pds);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("claims no handle for an account its host has taken down, as Bluesky's PDS answers", async () => {
    const takendown = fixture(async () => ({ ...ACCOUNT, host: "https://pds.ship.space", status: "takendown" }));
    const response = await resolve("https://ada.ship.space/.well-known/atproto-did", takendown.pds);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(takendown.dispose).toHaveBeenCalledOnce();
  });

  it("refuses methods other than GET and HEAD before looking up the repository", async () => {
    const f = fixture(async () => ACCOUNT);
    const response = await resolve("https://ada.ship.space/.well-known/atproto-did", f.pds, "POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(f.getInstallation).not.toHaveBeenCalled();
  });

  it("reports a failed lookup as unavailable and releases the repository", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture(async () => {
      throw new Error("PDS unavailable");
    });
    const response = await resolve("https://ada.ship.space/.well-known/atproto-did", f.pds);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(
      "[Gateway] Public repository lookup failed:",
      expect.objectContaining({ exceptionMessage: "PDS unavailable" }),
    );
  });
});
