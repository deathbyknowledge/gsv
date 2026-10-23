import type { FederationShipDocumentV2 } from "@humansandmachines/gsv/protocol";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { canonicalJson, normalizeFederationOrigin, sha256Base64Url, verifySignedValue } from "../federation-crypto";

export const SHIP_DOCUMENT_V2_PATH = "/.well-known/gsv/federation/v2/ship";
const DOCUMENT_LIFETIME_MS = 10 * 60_000;

export async function localShipDocumentV2(ctx: KernelContext): Promise<FederationShipDocumentV2> {
  const origin = ctx.installationIdentity?.canonicalOrigin;
  if (!origin) throw new Error("Installation has no canonical origin for federation");
  const identity = await ctx.federationIdentity.ensure(origin);
  const now = Date.now();
  const unsigned: Omit<FederationShipDocumentV2, "signature"> = {
    version: 2, domain: "gsv-federation/2/ship", shipId: identity.shipId,
    origin: identity.origin, publicKey: identity.publicKey, protocols: ["gsv-federation/2"],
    features: ["messages", "approaches"], issuedAtMs: now, expiresAtMs: now + DOCUMENT_LIFETIME_MS,
  };
  return { ...unsigned, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(unsigned)) };
}

export async function verifyShipDocumentV2(document: FederationShipDocumentV2): Promise<void> {
  const { signature, ...unsigned } = document;
  if (normalizeFederationOrigin(document.origin) !== document.origin) throw new Error("Ship document origin is not canonical");
  if (document.shipId !== `ship:${await sha256Base64Url(canonicalJson(jsonValueSchema.parse(document.publicKey)))}`) {
    throw new Error("Ship document identity does not match its public key");
  }
  const now = Date.now();
  if (document.issuedAtMs > now + 5 * 60_000 || document.expiresAtMs <= now
    || document.expiresAtMs <= document.issuedAtMs || document.expiresAtMs - document.issuedAtMs > DOCUMENT_LIFETIME_MS) {
    throw new Error("Ship document validity window is invalid");
  }
  if (!await verifySignedValue(document.publicKey, jsonValueSchema.parse(unsigned), signature)) {
    throw new Error("Ship document signature is invalid");
  }
}
