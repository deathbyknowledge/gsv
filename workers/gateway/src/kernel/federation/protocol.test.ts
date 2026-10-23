import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import type { KernelContext } from "../context";
import { FederationIdentity } from "../federation-crypto";
import { handleFederationHttpRequest } from "../federation";
import { localShipDocumentV2, verifyShipDocumentV2 } from "./protocol";

describe("Ship document v2", () => {
  it("signs a document that verifies against its own identity", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const document = await localShipDocumentV2(protocolContext(new FederationIdentity(storage)));
      await expect(verifyShipDocumentV2(document)).resolves.toBeUndefined();
      await expect(verifyShipDocumentV2({ ...document, signature: "invalid" })).rejects.toThrow("signature");
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
