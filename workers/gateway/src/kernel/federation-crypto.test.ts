import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FederationShipDocument } from "@humansandmachines/gsv/protocol";
import { getDurableObjectByName } from "../shared/durable-object";
import type { Kernel } from "./do";
import {
  canonicalJson,
  deriveContactSecret,
  FederationIdentity,
  randomBase64Url,
  signContactEnvelope,
  verifyContactEnvelope,
  verifyShipDocument,
} from "./federation-crypto";

async function withIdentity<Result>(
  callback: (identity: FederationIdentity) => Result | Promise<Result>,
): Promise<Result> {
  const kernel = await getDurableObjectByName<Env, Kernel>(
    env.KERNEL,
    `federation-identity-${crypto.randomUUID()}`,
  );
  return await runInDurableObject(kernel, async (_instance: Kernel, state) => (
    await callback(new FederationIdentity(state.storage))
  ));
}

describe("federation cryptography", () => {
  it("persists one self-certifying Ship identity for its canonical origin", async () => {
    await withIdentity(async (identity) => {
      const first = await identity.ensure("https://first.example");
      const second = await identity.ensure("https://first.example/");

      expect(second).toEqual(first);
      expect(first.shipId).toMatch(/^ship:/);
      await expect(verifyShipDocument(first)).resolves.toBeUndefined();
      await expect(identity.ensure("https://other.example"))
        .rejects.toThrow("origin conflicts");
    });
  });

  it("rejects a Ship document whose signed identity was changed", async () => {
    await withIdentity(async (identity) => {
      const document = await identity.ensure("https://first.example");
      const tampered: FederationShipDocument = {
        ...document,
        origin: "https://other.example",
      };
      await expect(verifyShipDocument(tampered)).rejects.toThrow("signature is invalid");
    });
  });

  it("derives the same contact secret on both Ships and authenticates envelopes", async () => {
    const token = randomBase64Url(32);
    const first = await deriveContactSecret(token, "ship:first", "ship:second");
    const second = await deriveContactSecret(token, "ship:second", "ship:first");
    const payload = { deliveryId: "delivery:1", value: [1, true, null] };
    const signature = await signContactEnvelope(first, payload);

    expect(second).toBe(first);
    await expect(verifyContactEnvelope(second, payload, signature)).resolves.toBe(true);
    await expect(verifyContactEnvelope(second, { ...payload, deliveryId: "delivery:2" }, signature))
      .resolves.toBe(false);
  });

  it("canonicalizes object keys without changing array order", () => {
    expect(canonicalJson({ z: 1, a: [3, 2, 1], nested: { b: true, a: false } }))
      .toBe('{"a":[3,2,1],"nested":{"a":false,"b":true},"z":1}');
  });
});
