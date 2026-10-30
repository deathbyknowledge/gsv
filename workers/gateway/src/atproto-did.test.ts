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

describe("remembered handle answers", () => {
  const URL_ADA = "https://ada.ship.space/.well-known/atproto-did";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers for a minute from the DID the host gave, so a takedown shows within a minute", async () => {
    vi.useFakeTimers();
    let account: PublicRepositoryAccount = { ...ACCOUNT, host: "https://pds.ship.space" };
    const f = fixture(async () => account);
    expect(await (await resolve(URL_ADA, f.pds)).text()).toBe(ACCOUNT.did);
    account = { ...account, status: "takendown" };

    await vi.advanceTimersByTimeAsync(59_000);
    const remembered = await resolve(URL_ADA, f.pds, "HEAD");
    expect(remembered.status).toBe(200);
    expect(remembered.headers.get("cache-control")).toBe("no-store");
    expect(f.getInstallation).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect((await resolve(URL_ADA, f.pds)).status).toBe(404);
    expect(f.getInstallation).toHaveBeenCalledTimes(2);
  });

  it("asks the host every time about a hostname it gave no DID for, so a new account resolves at once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const live = { ...ACCOUNT, host: "https://pds.ship.space" };
    const answers: (PublicRepositoryAccount | null | Error)[] = [
      null,
      { ...live, handle: "ada.gsv.space" },
      { ...live, status: "takendown" },
      new Error("PDS unavailable"),
      live,
    ];
    const f = fixture(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await resolve(URL_ADA, f.pds)).status);
    expect(statuses).toEqual([404, 404, 404, 503, 200]);
    expect(f.getInstallation).toHaveBeenCalledTimes(5);
  });

  it("asks the host again once the hostname routes to another installation", async () => {
    const f = fixture(async () => ({ ...ACCOUNT, host: "https://pds.ship.space" }));
    await resolve(URL_ADA, f.pds);
    const moved = await serveAtprotoDid(new Request(URL_ADA), f.pds, "inst_reset");
    expect(moved.status).toBe(200);
    expect(f.getInstallation.mock.calls).toEqual([[INSTALLATION_ID], ["inst_reset"]]);
  });

  it("remembers at most 1,024 hostnames, forgetting the oldest answer first", async () => {
    const getInstallation = vi.fn(async (installationId: string) => ({
      account: async () => ({ did: `did:plc:${installationId}`, handle: `${installationId}.ship.space`, host: "https://pds.ship.space" }),
      [Symbol.dispose]: () => undefined,
    }));
    // SAFETY: The route reads only the repository's account.
    const pds = { getInstallation } as never;
    const ask = (name: string) => serveAtprotoDid(new Request(`https://${name}.ship.space/.well-known/atproto-did`), pds, name);
    for (let i = 0; i <= 1_024; i += 1) await ask(`s${i}`);
    getInstallation.mockClear();
    expect(await (await ask("s1")).text()).toBe("did:plc:s1");
    expect(getInstallation).not.toHaveBeenCalled();
    expect(await (await ask("s0")).text()).toBe("did:plc:s0");
    expect(getInstallation).toHaveBeenCalledWith("s0");
  });
});
