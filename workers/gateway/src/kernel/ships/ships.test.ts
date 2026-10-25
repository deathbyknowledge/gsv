import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { signServiceAuth } from "@humansandmachines/gsv-pds/src/host/service-auth";
import type { PublicRepository } from "@humansandmachines/gsv/services/pds";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDurableObjectByName } from "../../shared/durable-object";
import {
  claimsOf,
  randomPlcDid,
  serviceAuthToken,
  signedJwt,
  TEST_PDS_URL,
  TEST_PLC_URL,
  TestShipNetwork,
  tokenClaims,
  type TestDidAccount,
} from "../../test-support/ship-network";
import type { KernelContext } from "../context";
import type { Kernel } from "../do";
import { FederationStore } from "../federation-store";
import { ShipCallNonces } from "./auth";
import { DidDeactivatedError, DidDirectoryUnavailableError, DidDocumentStore, DidNotResolvedError, isDidCached, resolveDid, resolveHandle } from "./did-directory";
import { ShipIdentity } from "./identity";
import { callShip, handleShipXrpc, type ShipCall, type ShipMethods } from "./xrpc";

const DAY_MS = 24 * 60 * 60_000;

type TestShip = { ctx: KernelContext; settle: () => Promise<void> };

let network: TestShipNetwork;

beforeEach(() => {
  network = new TestShipNetwork().install();
});

afterEach(() => vi.restoreAllMocks());

describe("resolving DIDs", () => {
  it("reads a did:plc from its verified history, then answers from its cache", async () => {
    const alice = await network.account("alice.ship.test");
    await withShip(async ({ ctx }) => {
      expect(await resolveDid(alice.did, ctx)).toEqual({
        did: alice.did,
        handle: "alice.ship.test",
        signingKey: { type: "Multikey", publicKeyMultibase: expect.stringMatching(/^zQ3s/) },
        shipEndpoint: "https://alice.ship.test",
        pdsEndpoint: TEST_PDS_URL,
      });
      const lookups = vi.mocked(fetch).mock.calls.length;
      expect(await resolveDid(alice.did, ctx)).toMatchObject({ did: alice.did });
      expect(vi.mocked(fetch).mock.calls).toHaveLength(lookups);
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(`${TEST_PLC_URL}/${alice.did}/log/audit`);
    });
  });

  it("refuses a history that doesn't verify back to the DID", async () => {
    const alice = await network.account("alice.ship.test");
    const bob = await network.account("bob.ship.test");
    const aliceLog = await (await network.auditLog(alice.did)).json<{ operation: { alsoKnownAs?: string[] } }[]>();
    await withShip(async ({ ctx }) => {
      // Alice's genesis operation doesn't hash to Bob's DID.
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(aliceLog));
      await expect(resolveDid(bob.did, ctx)).rejects.toThrow(DidNotResolvedError);
      // Changing a signed operation breaks its signature and its CID.
      const [genesis] = aliceLog;
      vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ ...genesis, operation: { ...genesis?.operation, alsoKnownAs: ["at://bob.ship.test"] } }]));
      await expect(resolveDid(alice.did, ctx)).rejects.toThrow(DidNotResolvedError);
      expect(isDidCached(alice.did, ctx) || isDidCached(bob.did, ctx)).toBe(false);
    });
  });

  it("forgets a DID once it is deactivated", async () => {
    const alice = await network.account("alice.ship.test");
    await withShip(async ({ ctx }) => {
      await resolveDid(alice.did, ctx);
      await network.deactivate(alice);
      await expect(resolveDid(alice.did, ctx, { refresh: true })).rejects.toThrow(DidDeactivatedError);
      expect(isDidCached(alice.did, ctx)).toBe(false);
    });
  });

  it("deactivates a DID only by a tombstone its own history verifies", async () => {
    const alice = await network.account("alice.ship.test");
    const bob = await network.account("bob.ship.test");
    await network.deactivate(bob);
    const aliceLog = await (await network.auditLog(alice.did)).json<{ cid: string }[]>();
    const bobLog = await (await network.auditLog(bob.did)).json<{ cid: string }[]>();
    await withShip(async ({ ctx }) => {
      // A directory that splices Bob's tombstone into Alice's history can't deactivate her.
      vi.mocked(fetch).mockResolvedValueOnce(Response.json([...aliceLog, bobLog.at(-1)]));
      const refusal = await resolveDid(alice.did, ctx).catch((cause: unknown) => cause);
      expect(refusal).toBeInstanceOf(DidNotResolvedError);
      expect(refusal).not.toBeInstanceOf(DidDeactivatedError);
    });
  });

  it("keeps a cached document while the directory is unreachable, and refreshes it after a day", async () => {
    const alice = await network.account("alice.ship.test");
    const stranger = await network.account("stranger.ship.test");
    await withShip(async ({ ctx, settle }) => {
      const cached = await resolveDid(alice.did, ctx);
      network.plcReachable = false;
      await expect(resolveDid(stranger.did, ctx)).rejects.toThrow(DidDirectoryUnavailableError);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + DAY_MS + 1);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await resolveDid(alice.did, ctx)).toEqual(cached);
      await settle();
      expect(warn).toHaveBeenCalledWith("[Kernel] DID document refresh failed", expect.stringContaining("Network connection lost"));
      expect(isDidCached(alice.did, ctx)).toBe(true);

      network.plcReachable = true;
      const moved = await network.rotateSigningKey(alice);
      expect(await resolveDid(alice.did, ctx)).toEqual(cached);
      await settle();
      expect((await resolveDid(alice.did, ctx)).signingKey.publicKeyMultibase).toBe(moved);
    });
  });

  it("reads a did:web from the document its host serves", async () => {
    const web = await network.webAccount("web.example");
    await withShip(async ({ ctx }) => {
      expect(await resolveDid(web.did, ctx)).toEqual({
        did: web.did,
        handle: "web.example",
        signingKey: { type: "Multikey", publicKeyMultibase: expect.stringMatching(/^zDn/) },
        shipEndpoint: "https://web.example",
        pdsEndpoint: null,
      });
      await expect(resolveDid("did:web:localhost", ctx)).rejects.toThrow(DidNotResolvedError);
    });
  });

  it("leaves no timer running once a lookup ends", async () => {
    const alice = await network.account("alice.ship.test");
    const name = `ships-${crypto.randomUUID()}`;
    await withShip(async ({ ctx }) => void await resolveDid(alice.did, ctx), undefined, name);
    // A Kernel with a timer pending isn't idle, so one the lookup left behind holds it awake.
    const stopping = evictDurableObject(await getDurableObjectByName<Env, Kernel>(env.KERNEL, name)).then(() => "stopped");
    expect(await Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 2_000, "held"))])).toBe("stopped");
  });

  it("accepts a handle only when it and its DID name each other", async () => {
    const alice = await network.account("alice.ship.test");
    network.hosts.set("alice.ship.test", () => new Response(alice.did));
    // Mallory's host claims Alice's DID, but Alice's document names another handle.
    network.hosts.set("mallory.ship.test", () => new Response(`${alice.did}\n`));
    network.hosts.set("nobody.ship.test", () => new Response("Not Found", { status: 404 }));
    await withShip(async ({ ctx }) => {
      expect(await resolveHandle("Alice.Ship.Test", ctx)).toMatchObject({ did: alice.did, handle: "alice.ship.test" });
      await expect(resolveHandle("mallory.ship.test", ctx)).rejects.toThrow("@mallory.ship.test's account doesn't claim that handle");
      await expect(resolveHandle("nobody.ship.test", ctx)).rejects.toThrow("@nobody.ship.test names no account");
    });
  });
});

describe("serving Ship methods", () => {
  const received: ShipCall[] = [];
  const METHODS: ShipMethods = new Map([
    ["space.ship.echo", { type: "procedure", callsPerMinute: 3, handle: async (call) => {
      received.push(call);
      return { caller: call.caller, input: call.input ?? null };
    } }],
    ["space.ship.peek", { type: "query", callsPerMinute: 3, handle: async (call) => new Response(`peeked ${call.params.get("id")}`) }],
  ]);

  beforeEach(() => {
    received.length = 0;
  });

  it("hands an authenticated call to its method", async () => {
    const [alice, bob] = [await network.account("alice.ship.test"), await network.account("bob.ship.test")];
    await withShip(async ({ ctx }) => {
      const response = await handleShipXrpc(post("space.ship.echo", await serviceAuthToken(alice, bob, "space.ship.echo"), { text: "hi" }), ctx, METHODS);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ caller: alice.did, input: { text: "hi" } });

      const query = new Request("https://bob.ship.test/xrpc/space.ship.peek?id=7", {
        headers: { authorization: `Bearer ${await serviceAuthToken(alice, bob, "space.ship.peek")}` },
      });
      expect(await (await handleShipXrpc(query, ctx, METHODS)).text()).toBe("peeked 7");
    }, bob);
  });

  it("refuses tokens for another Ship, another method, or past their time", async () => {
    const [alice, bob, carol] = [await network.account("alice.ship.test"), await network.account("bob.ship.test"), await network.account("carol.ship.test")];
    await withShip(async ({ ctx }) => {
      const now = Date.now();
      const refusals = [
        [undefined, "AuthMissing"],
        ["not-a-jwt", "BadJwt"],
        [await signServiceAuth(alice.did, alice.signingHex, { aud: `${carol.did}#ship`, lxm: "space.ship.echo" }), "BadJwtAudience"],
        [await signServiceAuth(alice.did, alice.signingHex, { aud: `${bob.did}#atproto_pds`, lxm: "space.ship.echo" }), "BadJwtAudience"],
        [await serviceAuthToken(alice, bob, "space.ship.peek"), "BadJwtLexiconMethod"],
        [await signServiceAuth(alice.did, alice.signingHex, { aud: `${bob.did}#ship`, lxm: "space.ship.echo" }, now - 120_000), "JwtExpired"],
        [await signedJwt({ typ: "JWT", alg: "HS256" }, tokenClaims(alice, bob, "space.ship.echo"), alice), "BadJwt"],
        [await signedJwt({ typ: "at+jwt", alg: "ES256K" }, tokenClaims(alice, bob, "space.ship.echo"), alice), "BadJwt"],
        [await signedJwt({ typ: "JWT", alg: "ES256K" }, { ...tokenClaims(alice, bob, "space.ship.echo"), exp: Math.floor(now / 1000) + 3_600 }, alice), "BadJwt"],
      ] as const;
      for (const [presented, error] of refusals) {
        const response = await handleShipXrpc(post("space.ship.echo", presented), ctx, METHODS);
        expect([response.status, (await response.json<{ error: string }>()).error]).toEqual([401, error]);
      }
      expect(received).toEqual([]);
    }, bob);
  });

  it("refuses a forged or replayed token, and spends a nonce only for a valid signature", async () => {
    const [alice, bob, mallory] = [await network.account("alice.ship.test"), await network.account("bob.ship.test"), await network.account("mallory.ship.test")];
    await withShip(async ({ ctx }) => {
      const valid = await serviceAuthToken(alice, bob, "space.ship.echo");
      // Mallory signs Alice's claims, nonce included, with her own key.
      const forged = await signedJwt({ typ: "JWT", alg: "ES256K" }, claimsOf(valid), mallory);
      expect(await errorOf(handleShipXrpc(post("space.ship.echo", forged), ctx, METHODS))).toEqual([401, "BadJwtSignature"]);
      expect(await errorOf(handleShipXrpc(post("space.ship.echo", valid), ctx, METHODS))).toEqual([200, undefined]);
      expect(await errorOf(handleShipXrpc(post("space.ship.echo", valid), ctx, METHODS))).toEqual([401, "BadJwt"]);
      expect(received.map((call) => call.caller)).toEqual([alice.did]);
    }, bob);
  });

  it("accepts a caller's rotated key after one refresh of its document", async () => {
    const [alice, bob] = [await network.account("alice.ship.test"), await network.account("bob.ship.test")];
    await withShip(async ({ ctx }) => {
      expect(await errorOf(handleShipXrpc(post("space.ship.echo", await serviceAuthToken(alice, bob, "space.ship.echo")), ctx, METHODS))).toEqual([200, undefined]);
      const retired = alice.signingHex;
      await network.rotateSigningKey(alice);
      expect(await errorOf(handleShipXrpc(post("space.ship.echo", await serviceAuthToken(alice, bob, "space.ship.echo")), ctx, METHODS))).toEqual([200, undefined]);
      const stale = await signServiceAuth(alice.did, retired, { aud: `${bob.did}#ship`, lxm: "space.ship.echo" });
      expect(await errorOf(handleShipXrpc(post("space.ship.echo", stale), ctx, METHODS))).toEqual([401, "BadJwtSignature"]);
    }, bob);
  });

  it("verifies ES256 tokens from a did:web account", async () => {
    const [web, bob] = [await network.webAccount("web.example"), await network.account("bob.ship.test")];
    await withShip(async ({ ctx }) => {
      const signed = await signedJwt({ typ: "JWT", alg: "ES256" }, tokenClaims(web, bob, "space.ship.echo"), web);
      const response = await handleShipXrpc(post("space.ship.echo", signed), ctx, METHODS);
      expect(await response.json()).toMatchObject({ caller: web.did });
    }, bob);
  });

  it("asks a caller to retry while its identity can't be looked up", async () => {
    const [alice, bob] = [await network.account("alice.ship.test"), await network.account("bob.ship.test")];
    await withShip(async ({ ctx }) => {
      network.plcReachable = false;
      const response = await handleShipXrpc(post("space.ship.echo", await serviceAuthToken(alice, bob, "space.ship.echo")), ctx, METHODS);
      expect([response.status, response.headers.get("retry-after"), (await response.json<{ error: string }>()).error]).toEqual([503, "30", "UpstreamFailure"]);
    }, bob);
  });

  it("limits how many unknown callers it looks up", async () => {
    const bob = await network.account("bob.ship.test");
    await withShip(async ({ ctx }) => {
      // Each stranger's DID is unregistered, so each call costs a lookup and none is cached.
      const stranger = await network.account("stranger.ship.test", undefined, false);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 61; attempt++) {
        const unknown = { ...stranger, did: randomPlcDid() };
        statuses.push((await handleShipXrpc(post("space.ship.echo", await serviceAuthToken(unknown, bob, "space.ship.echo")), ctx, METHODS)).status);
      }
      expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    }, bob);
  });

  it("gives each caller its own budget for each method", async () => {
    const [alice, bob, carol] = [await network.account("alice.ship.test"), await network.account("bob.ship.test"), await network.account("carol.ship.test")];
    vi.useFakeTimers({ now: new Date("2026-10-24T12:00:30Z"), toFake: ["Date"] });
    try {
      await withShip(async ({ ctx }) => {
        const echo = async (caller: TestDidAccount) => await handleShipXrpc(post("space.ship.echo", await serviceAuthToken(caller, bob, "space.ship.echo")), ctx, METHODS);
        for (let call = 0; call < 3; call++) expect((await echo(alice)).status).toBe(200);
        const refused = await echo(alice);
        expect([refused.status, refused.headers.get("retry-after"), (await refused.json<{ error: string }>()).error]).toEqual([429, "30", "RateLimitExceeded"]);
        expect((await echo(carol)).status).toBe(200);
        const peek = new Request("https://bob.ship.test/xrpc/space.ship.peek?id=1", {
          headers: { authorization: `Bearer ${await serviceAuthToken(alice, bob, "space.ship.peek")}` },
        });
        expect((await handleShipXrpc(peek, ctx, METHODS)).status).toBe(200);
        // A call refused for its budget never reaches its method.
        expect(received.map((call) => call.caller)).toEqual([alice.did, alice.did, alice.did, carol.did]);
        vi.setSystemTime(new Date("2026-10-24T12:01:00Z"));
        expect((await echo(alice)).status).toBe(200);
      }, bob);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses every call before its first outward act gives it a DID", async () => {
    const [alice, bob] = [await network.account("alice.ship.test"), await network.account("bob.ship.test")];
    await withShip(async ({ ctx }) => {
      expect(await errorOf(handleShipXrpc(post("space.ship.echo", await serviceAuthToken(alice, bob, "space.ship.echo")), ctx, METHODS))).toEqual([401, "BadJwtAudience"]);
    });
  });

  it("names methods it doesn't serve, and the verb a method takes", async () => {
    const bob = await network.account("bob.ship.test");
    await withShip(async ({ ctx }) => {
      expect(await errorOf(handleShipXrpc(post("space.ship.unknown"), ctx, METHODS))).toEqual([501, "MethodNotImplemented"]);
      expect(await errorOf(handleShipXrpc(new Request("https://bob.ship.test/xrpc/space.ship.echo"), ctx, METHODS))).toEqual([405, "InvalidRequest"]);
    }, bob);
  });
});

describe("calling another Ship", () => {
  it("sends each call with its own token, which the other Ship accepts", async () => {
    const [alice, bob] = [await network.account("alice.ship.test"), await network.account("bob.ship.test")];
    const sent: { url: string; method: string; authorization: string | null; type: string | null; body: string }[] = [];
    network.hosts.set("bob.ship.test", async (request) => {
      sent.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization"), type: request.headers.get("content-type"), body: await request.text() });
      return Response.json({ state: "received" });
    });
    await withShip(async ({ ctx }) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await callShip(bob.did, "space.ship.echo", { input: { text: "hi" } }, ctx);
        expect(await response.json()).toEqual({ state: "received" });
      }
    }, alice);
    expect(sent.map(({ url, method, type, body }) => ({ url, method, type, body }))).toEqual(Array(2).fill({
      url: "https://bob.ship.test/xrpc/space.ship.echo",
      method: "POST",
      type: "application/json",
      body: JSON.stringify({ text: "hi" }),
    }));
    const [first, second] = sent.map((call) => claimsOf(call.authorization?.replace("Bearer ", "") ?? ""));
    expect(first).toMatchObject({ iss: alice.did, aud: `${bob.did}#ship`, lxm: "space.ship.echo" });
    expect(second?.jti).not.toBe(first?.jti);

    await withShip(async ({ ctx }) => {
      for (const call of sent) {
        const request = new Request(call.url, { method: call.method, headers: { authorization: call.authorization ?? "", "content-type": call.type ?? "" }, body: call.body });
        const methods: ShipMethods = new Map([["space.ship.echo", { type: "procedure", handle: async ({ caller, input }) => ({ caller, input: input ?? null }) }]]);
        expect(await (await handleShipXrpc(request, ctx, methods)).json()).toEqual({ caller: alice.did, input: { text: "hi" } });
      }
    }, bob);
  });

  it("refuses to call an account that offers no Ship service", async () => {
    const [alice, plain] = [await network.account("alice.ship.test"), await network.account("plain.example", {})];
    await withShip(async ({ ctx }) => {
      await expect(callShip(plain.did, "space.ship.echo", { input: {} }, ctx)).rejects.toThrow(`${plain.did} isn't a Ship`);
    }, alice);
  });
});

/** A Ship's Kernel storage and the context its Ship code reads; `as` gives it a DID, as a first outward act would. */
async function withShip<T>(use: (ship: TestShip) => Promise<T>, as?: TestDidAccount, name = `ships-${crypto.randomUUID()}`): Promise<T> {
  const kernel = await getDurableObjectByName<Env, Kernel>(env.KERNEL, name);
  return await runInDurableObject(kernel, async (_instance: Kernel, state) => {
    const deferred: Promise<unknown>[] = [];
    const shipIdentity = new ShipIdentity(state.storage);
    if (as) shipIdentity.remember(as.did);
    const repository: Partial<PublicRepository> = {
      account: async () => as ? { did: as.did, handle: as.handle, host: "https://pds.ship.test" } : null,
      serviceAuth: async (request) => {
        if (!as) throw new Error("RepoNotFound");
        return await signServiceAuth(as.did, as.signingHex, request);
      },
      [Symbol.dispose]: () => {},
    };
    // SAFETY: Ship code reads only the stores, binding, address and defer fields given here.
    const ctx = {
      installationId: "inst_ship",
      installationIdentity: { installationId: "inst_ship", canonicalOrigin: "https://ship.ship.test", handle: "ship" },
      env: { PLC_URL: TEST_PLC_URL, PDS: { getInstallation: async () => repository } },
      didDocuments: new DidDocumentStore(state.storage.sql),
      shipCallNonces: new ShipCallNonces(state.storage.sql),
      shipIdentity,
      federation: new FederationStore(state.storage),
      defer: (promise: Promise<unknown>) => void deferred.push(promise),
    } as KernelContext;
    return await use({ ctx, settle: async () => void await Promise.all(deferred.splice(0)) });
  });
}

function post(nsid: string, presented?: string, input: Record<string, string> = {}): Request {
  return new Request(`https://bob.ship.test/xrpc/${nsid}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(presented ? { authorization: `Bearer ${presented}` } : undefined) },
    body: JSON.stringify(input),
  });
}

async function errorOf(response: Promise<Response>): Promise<[number, string | undefined]> {
  const settled = await response;
  return [settled.status, (await settled.json<{ error?: string }>()).error];
}
