import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import type { KernelContext } from "../context";
import { FederationIdentity } from "../federation-crypto";
import { handleFederationHttpRequest } from "../federation";
import type { FederationContactRecord } from "../federation-store";
import { localShipDocumentV2, negotiateContactProtocol, verifyShipDocumentV2 } from "./protocol";

describe("federation version negotiation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("authenticates feature advertisement against the pinned identity without changing v1", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const identity = new FederationIdentity(storage);
      const v1 = await identity.ensure("https://remote.example");
      const context = protocolContext(identity);
      const document = await localShipDocumentV2(context);
      await expect(verifyShipDocumentV2(document)).resolves.toBeUndefined();
      expect(await identity.ensure("https://remote.example")).toEqual(v1);
      const contact = remoteContact(v1.shipId, v1.publicKey);
      const setProtocol = vi.fn((_id: string, _generation: string, protocol: NonNullable<FederationContactRecord["protocol"]>) => ({ ...contact, protocol }));
      // SAFETY: negotiation only calls setProtocol; its signature is checked against the store.
      context.federation = { setProtocol } as KernelContext["federation"];
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(document));
      expect((await negotiateContactProtocol(contact, context)).protocol?.version).toBe(2);
      expect(setProtocol).toHaveBeenCalledWith(contact.id, contact.generation, expect.objectContaining({ version: 2, features: ["messages", "approaches"] }));

      vi.mocked(fetch).mockResolvedValue(Response.json({ ...document, signature: "invalid" }));
      await expect(negotiateContactProtocol(contact, context)).rejects.toThrow("signature");
      expect(setProtocol).toHaveBeenCalledOnce();
    });
  });

  it("falls back only for a missing endpoint and never downgrades an established v2 peer", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const identity = new FederationIdentity(storage);
      const v1 = await identity.ensure("https://remote.example");
      const contact = remoteContact(v1.shipId, v1.publicKey);
      const context = protocolContext(identity);
      const setProtocol = vi.fn((_id: string, _generation: string, protocol: NonNullable<FederationContactRecord["protocol"]>) => ({ ...contact, protocol }));
      // SAFETY: negotiation only calls setProtocol; its signature is checked against the store.
      context.federation = { setProtocol } as KernelContext["federation"];
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
      expect((await negotiateContactProtocol(contact, context)).protocol?.version).toBe(1);
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
      await expect(negotiateContactProtocol(contact, context)).rejects.toThrow("401");
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
      await expect(negotiateContactProtocol({ ...contact, protocol: { version: 2, features: ["messages", "approaches"], checkedAtMs: 0 } }, context))
        .rejects.toThrow("previously negotiated v2");
      expect(setProtocol).toHaveBeenCalledOnce();
    });
  });

  it("accepts an empty POST stream for discovery and rejects a nonempty body", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const context = protocolContext(new FederationIdentity(storage));
      const url = "https://remote.example/.well-known/gsv/federation/v2/ship";
      const empty = new Request(url, { method: "POST", body: new ReadableStream({ start(controller) { controller.close(); } }) });
      const discovered = await handleFederationHttpRequest(empty, context);
      expect(discovered.status).toBe(200);
      expect(await discovered.json()).toMatchObject({ version: 2, features: ["messages", "approaches"] });
      const nonempty = await handleFederationHttpRequest(new Request(url, { method: "POST", body: "{}" }), context);
      expect(nonempty.status).toBe(400);
    });
  });
});

function protocolContext(identity: FederationIdentity): KernelContext {
  // SAFETY: these tests exercise only protocol identity and the supplied federation store method.
  return { env: {}, federationIdentity: identity, installationIdentity: { canonicalOrigin: "https://remote.example" } } as KernelContext;
}

function remoteContact(shipId: string, publicKey: FederationContactRecord["remotePublicKey"]): FederationContactRecord {
  return {
    preferences: { saved: true, muted: false, notifications: "notify", revision: 1 },
    blocked: false,
    id: "contact:remote", ownerUid: 1000, state: "active", generation: "generation:one",
    remoteShipId: shipId, remoteSubject: { id: "subject:remote", displayName: "Remote" },
    remoteOrigin: "https://remote.example", remotePublicKey: publicKey, sharedSecret: "fixture",
    conversationId: "conv:remote", threadId: "thread:one", createdAtMs: 1, updatedAtMs: 1,
  };
}
