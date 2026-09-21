import type { FederationShipDocumentV2 } from "@humansandmachines/gsv/protocol";
import { federationShipDocumentV2Schema, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { FederationContactRecord } from "../federation-store";
import { canonicalJson, normalizeFederationOrigin, sha256Base64Url, verifySignedValue } from "../federation-crypto";
import { FederationHttpError } from "./errors";
import { fetchFederationJson } from "./http";

export const SHIP_DOCUMENT_V2_PATH = "/.well-known/gsv/federation/v2/ship";
export const DELIVERY_V2_PATH = "/_gsv/federation/v2/deliver";
const DOCUMENT_LIFETIME_MS = 10 * 60_000;
const NEGOTIATION_CACHE_MS = 24 * 60 * 60_000;

export async function localShipDocumentV2(ctx: KernelContext): Promise<FederationShipDocumentV2> {
  const origin = ctx.installationIdentity?.canonicalOrigin;
  if (!origin) throw new Error("Installation has no canonical origin for federation");
  const identity = await ctx.federationIdentity.ensure(origin);
  const now = Date.now();
  const unsigned: Omit<FederationShipDocumentV2, "signature"> = {
    version: 2, domain: "gsv-federation/2/ship", shipId: identity.shipId,
    origin: identity.origin, publicKey: identity.publicKey, protocols: ["gsv-federation/2"],
    features: ["messages", "approaches", "work"], issuedAtMs: now, expiresAtMs: now + DOCUMENT_LIFETIME_MS,
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

export async function negotiateContactProtocol(contact: FederationContactRecord, ctx: KernelContext): Promise<FederationContactRecord> {
  if (contact.protocol && contact.protocol.checkedAtMs + NEGOTIATION_CACHE_MS > Date.now()) return contact;
  let document: FederationShipDocumentV2;
  try {
    document = federationShipDocumentV2Schema.parse(await fetchFederationJson(`${contact.remoteOrigin}${SHIP_DOCUMENT_V2_PATH}`, {
      method: "POST", headers: { accept: "application/json" }, signal: ctx.requestSignal,
    }, ctx));
  } catch (error) {
    if (!(error instanceof FederationHttpError) || ![404, 410, 501].includes(error.status)) throw error;
    if (contact.protocol?.version === 2) throw new Error("A previously negotiated v2 peer no longer advertises v2");
    return ctx.federation.setProtocol(contact.id, contact.generation, { version: 1, features: [], checkedAtMs: Date.now() });
  }
  await verifyShipDocumentV2(document);
  if (document.shipId !== contact.remoteShipId || document.origin !== contact.remoteOrigin
    || canonicalJson(jsonValueSchema.parse(document.publicKey)) !== canonicalJson(jsonValueSchema.parse(contact.remotePublicKey))) {
    throw new Error("Ship document does not match the pinned contact");
  }
  return ctx.federation.setProtocol(contact.id, contact.generation, {
    version: 2, features: document.features, checkedAtMs: Date.now(),
  });
}
