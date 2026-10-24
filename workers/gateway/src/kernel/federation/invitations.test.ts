import { reset } from "cloudflare:test";
import { ACCEPT_INVITATION, encodeContactInvitation, parseContactInvitation } from "@humansandmachines/gsv/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  serviceAuthToken,
  signedJwt,
  TestShipNetwork,
  tokenClaims,
  type TestDidAccount,
} from "../../test-support/ship-network";
import { SPACE_OWNER_UID, testSpace, type TestSpace } from "../../test-support/ship-spaces";
import { SHIP_METHODS } from "../ships/methods";
import { handleShipXrpc } from "../ships/xrpc";
import { handleContactInviteAccept, handleContactInviteCancel, handleContactInviteCreate } from "./invitations";

let network: TestShipNetwork;
let alice: TestSpace;
let bob: TestSpace;
let mallory: TestSpace;

beforeEach(async () => {
  network = new TestShipNetwork().install();
  [alice, bob, mallory] = [await testSpace(network, "alice"), await testSpace(network, "bob"), await testSpace(network, "mallory")];
});

afterEach(async () => {
  // Responsibility alarms belong to this test's Kernels, not the next test's network.
  await reset();
  vi.restoreAllMocks();
});

describe("invitations", () => {
  it("connects two people, each Ship naming the other by DID", async () => {
    const { code } = await alice.run((ctx) => handleContactInviteCreate({ shipHandlesMessages: false }, ctx));
    expect(parseContactInvitation(code).invitation).toMatchObject({ version: 2, did: alice.account.did, handle: "alice.ship.test", name: "Alice" });

    const { contact } = await bob.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: true }, ctx));
    expect(contact).toMatchObject({ state: "active", remoteDid: alice.account.did, remoteName: "Alice", remoteHandle: "alice.ship.test" });
    expect(contact.preferences?.shipHandlesMessages).toBe(true);
    const inviter = await alice.run((ctx) => ({
      contact: ctx.federation.getByRemote(SPACE_OWNER_UID, bob.account.did),
      invites: ctx.federation.listInvites(SPACE_OWNER_UID, true, Date.now()),
    }));
    expect(inviter.contact).toMatchObject({ remoteDid: bob.account.did, remoteName: "Bob", remoteHandle: "bob.ship.test", generation: contact.generation });
    expect(inviter.invites).toMatchObject([{ state: "accepted", acceptedRemoteDid: bob.account.did, acceptedContactId: inviter.contact?.id }]);

    // Accepting again finds the same contact without asking the inviting Ship.
    const calls = vi.mocked(fetch).mock.calls.length;
    expect((await bob.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: true }, ctx))).contact).toEqual(contact);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  });

  it("makes the Ship that signed the acceptance the contact, whichever name it gives", async () => {
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    const { token } = parseContactInvitation(code).invitation;
    const response = await callAcceptInvitation(mallory.account, alice, { token, name: "Bob" });
    expect(response.status).toBe(200);
    expect(await alice.run((ctx) => [bob.account.did, mallory.account.did].map((did) => ctx.federation.getByRemote(SPACE_OWNER_UID, did)?.remoteHandle ?? null)))
      .toEqual([null, "mallory.ship.test"]);
  });

  it.each([false, true])("refuses an acceptance signed for another Ship, leaving its contact unchanged=%s", async (connected) => {
    if (connected) await connect(alice, bob);
    const before = await alice.run((ctx) => ctx.federation.getByRemote(SPACE_OWNER_UID, bob.account.did));
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    const { token } = parseContactInvitation(code).invitation;
    const forged = await signedJwt({ typ: "JWT", alg: "ES256K" }, tokenClaims(bob.account, alice.account, ACCEPT_INVITATION), mallory.account);
    const response = await callAcceptInvitation(bob.account, alice, { token, name: "Bob" }, forged);
    expect(response.status).toBe(401);
    expect(await alice.run((ctx) => ({
      contact: ctx.federation.getByRemote(SPACE_OWNER_UID, bob.account.did),
      invite: ctx.federation.inviteByTokenHash(ctx.federation.listInvites(SPACE_OWNER_UID, true, Date.now())[0]!.tokenHash)?.state,
    }))).toEqual({ contact: before, invite: "issued" });
  });

  it("refuses a replay of an accepted invitation from any other Ship", async () => {
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    const { contact } = await bob.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: false }, ctx));
    const { token } = parseContactInvitation(code).invitation;
    const replay = await callAcceptInvitation(mallory.account, alice, { token, name: "Mallory" });
    expect([replay.status, (await replay.json<{ error: string }>()).error]).toEqual([409, "InvitationUsed"]);
    expect(await alice.run((ctx) => ({
      bob: ctx.federation.getByRemote(SPACE_OWNER_UID, bob.account.did)?.generation,
      mallory: ctx.federation.getByRemote(SPACE_OWNER_UID, mallory.account.did),
    }))).toEqual({ bob: contact.generation, mallory: null });
  });

  it("refuses a code whose address belongs to another Ship before calling either", async () => {
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    const { invitation } = parseContactInvitation(code);
    for (const forged of [{ ...invitation, handle: "bob.ship.test" }, { ...invitation, did: mallory.account.did }]) {
      const calls = vi.mocked(fetch).mock.calls.length;
      await expect(bob.run((ctx) => handleContactInviteAccept({ code: encodeContactInvitation(forged), shipHandlesMessages: false }, ctx)))
        .rejects.toThrow("This invitation's address doesn't belong to the Ship that sent it");
      expect(vi.mocked(fetch).mock.calls.slice(calls).map(([input]) => new URL(String(input)).pathname)).not.toContain(`/xrpc/${ACCEPT_INVITATION}`);
    }
  });

  it("stops when the person cancels, before calling the inviting Ship", async () => {
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    // The person cancels while their Ship looks up the invitation's address.
    await expect(bob.run((ctx) => {
      const controller = new AbortController();
      network.hosts.set("alice.ship.test", async (request) => {
        controller.abort(new Error("Pairing cancelled"));
        return await new Promise<Response>((_resolve, reject) => {
          if (request.signal.aborted) reject(request.signal.reason);
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      });
      return handleContactInviteAccept({ code, shipHandlesMessages: false }, { ...ctx, requestSignal: controller.signal });
    })).rejects.toThrow(/^Pairing cancelled$/);
    expect(vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname)).not.toContain(`/xrpc/${ACCEPT_INVITATION}`);
    expect(await bob.run((ctx) => ctx.federation.listInvites(SPACE_OWNER_UID, true, Date.now()))).toEqual([]);
  });

  it("says in plain words why the inviting Ship refused", async () => {
    const { code, inviteId } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    await alice.run((ctx) => handleContactInviteCancel({ inviteId }, ctx));
    await expect(bob.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: false }, ctx)))
      .rejects.toThrow(/^This invitation was cancelled\.$/);
    // The refusal is final, so a retry doesn't call again.
    await expect(bob.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: false }, ctx)))
      .rejects.toThrow("Contact pairing attempt is terminal (remote-rejected:410)");
  });

  it("asks for a new invitation when the code is from before DIDs", async () => {
    const old = { version: 1, origin: "https://alice.ship.test", shipId: "ship:alice", token: "t", expiresAtMs: Date.now() + 60_000 };
    const outdated = `gsv-contact-v1:${btoa(JSON.stringify(old)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    await expect(bob.run((ctx) => handleContactInviteAccept({ code: outdated, shipHandlesMessages: false }, ctx)))
      .rejects.toThrow("This invitation is from before an update. Ask for a new one.");
  });

  it.each([false, true])("refuses a new acceptance once the person is removed mid-call, answering one already made=%s", async (accepted) => {
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    const { token } = parseContactInvitation(code).invitation;
    const before = accepted ? await (await callAcceptInvitation(bob.account, alice, { token, name: "Bob" })).json() : null;
    const authorization = `Bearer ${await serviceAuthToken(bob.account, alice.account, ACCEPT_INVITATION)}`;
    const serve = network.hosts.get("bob.ship.test");
    const outcome = await alice.run(async (ctx, storage) => {
      // Alice is removed while her Ship checks the caller's handle.
      const checking = Promise.withResolvers<void>();
      const removed = Promise.withResolvers<void>();
      network.hosts.set("bob.ship.test", async (request) => {
        checking.resolve();
        await removed.promise;
        if (!serve) throw new Error("Bob's Ship has no host");
        return await serve(request);
      });
      const pending = handleShipXrpc(new Request(`https://${alice.hostname}/xrpc/${ACCEPT_INVITATION}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ token, name: "Bob" }),
      }), ctx, SHIP_METHODS);
      await checking.promise;
      storage.sql.exec("INSERT INTO account_access (uid, disabled_at) VALUES (?, ?)", SPACE_OWNER_UID, Date.now());
      ctx.auth.invalidateCredentials(SPACE_OWNER_UID, "test account disabled");
      removed.resolve();
      const response = await pending;
      return {
        status: response.status,
        body: await response.json(),
        invite: ctx.federation.listInvites(SPACE_OWNER_UID, true, Date.now())[0]?.state,
      };
    });
    expect(outcome).toMatchObject(accepted
      ? { status: 200, body: before, invite: "accepted" }
      : { status: 404, invite: "issued" });
  });

  it("waits while contacts move to DIDs, telling callers to retry", async () => {
    const { code } = await alice.run((ctx) => handleContactInviteCreate({}, ctx));
    await alice.run((ctx, storage) => {
      storage.sql.exec(`INSERT INTO federation_actor_blocks_legacy (owner_uid, ship_id, subject_id, display_name, created_at)
        VALUES (?, 'ship:old', 'subject:old', 'Old', 1)`, SPACE_OWNER_UID);
      expect(ctx.federation.awaitingMove()).toBe(true);
    });
    await expect(alice.run((ctx) => handleContactInviteCreate({}, ctx))).rejects.toThrow("Your contacts are moving to the open network");
    const { token } = parseContactInvitation(code).invitation;
    const response = await callAcceptInvitation(bob.account, alice, { token, name: "Bob" });
    expect([response.status, response.headers.get("retry-after"), (await response.json<{ error: string }>()).error])
      .toEqual([503, "300", "TemporarilyUnavailable"]);
  });
});

/** Connects two spaces' people through an invitation. */
async function connect(inviter: TestSpace, acceptor: TestSpace): Promise<void> {
  const { code } = await inviter.run((ctx) => handleContactInviteCreate({}, ctx));
  await acceptor.run((ctx) => handleContactInviteAccept({ code, shipHandlesMessages: false }, ctx));
}

/** Calls `space.ship.acceptInvitation` on a space as `caller`, with its own token unless one is given. */
async function callAcceptInvitation(caller: TestDidAccount, to: TestSpace, input: { token: string; name: string }, token?: string): Promise<Response> {
  return await fetch(`https://${to.hostname}/xrpc/${ACCEPT_INVITATION}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token ?? await serviceAuthToken(caller, to.account, ACCEPT_INVITATION)}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
