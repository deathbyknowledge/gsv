import { P256PrivateKeyExportable, Secp256k1PrivateKey, Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { deriveDidFromGenesisOp, signOperation, signTombstone, type CompatibleOperationOrTombstone, type Service } from "@atcute/did-plc";
import { toBase64Url } from "@atcute/multibase";
import { signServiceAuth } from "@humansandmachines/gsv-pds/src/host/service-auth";
import { FakePlcDirectory } from "@humansandmachines/gsv-pds/test/plc";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { vi } from "vitest";
import * as z from "zod/mini";

/** The directory Ship tests register DIDs with; the test Worker's `PLC_URL` names it. */
export const TEST_PLC_URL = "https://plc.test";
/** Where test accounts keep their repositories. */
export const TEST_PDS_URL = "https://pds.ship.test";

/** A did:plc account a test controls: its rotation key and its current signing key. */
export type TestDidAccount = { did: string; handle: string; rotation: Secp256k1PrivateKeyExportable; signingHex: string; services: Record<string, Service> };
export type TestWebAccount = { did: string; p256: P256PrivateKeyExportable };
export type JwtHeader = { typ: string; alg: string };
export const tokenClaimsSchema = z.object({ iss: z.string(), aud: z.string(), lxm: z.string(), iat: z.number(), exp: z.number(), jti: z.string() });
export type TokenClaims = z.infer<typeof tokenClaimsSchema>;
type Host = (request: Request) => Response | Promise<Response>;

/**
 * The network Ship tests run against: a fake PLC directory and HTTPS hosts by
 * hostname, installed as the global fetch. Unknown hosts throw, as a lost
 * connection does.
 */
export class TestShipNetwork {
  readonly plc = new FakePlcDirectory();
  readonly hosts = new Map<string, Host>();
  /** Records test spaces publish, by AT URI; their repository host serves them. */
  readonly records = new Map<string, { cid: string; value: JsonObject }>();
  plcReachable = true;

  install(): this {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === TEST_PLC_URL) {
        if (!this.plcReachable) throw new TypeError("Network connection lost.");
        return await this.plc.handle(request);
      }
      const host = this.hosts.get(url.host);
      if (!host) throw new TypeError(`Unexpected request to ${request.url}`);
      return await host(request);
    });
    return this;
  }

  /** Registers a did:plc for a handle, with its repository on TEST_PDS_URL and a Ship service at the handle, unless told otherwise. */
  async account(handle: string, services?: Record<string, Service>, register = true): Promise<TestDidAccount> {
    const rotation = await Secp256k1PrivateKeyExportable.createKeypair();
    const signing = await Secp256k1PrivateKeyExportable.createKeypair();
    const offered = services ?? {
      atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: TEST_PDS_URL },
      ship: { type: "ShipService", endpoint: `https://${handle}` },
    };
    const genesis = await signOperation({
      type: "plc_operation",
      prev: null,
      rotationKeys: [await rotation.exportPublicKey("did")],
      verificationMethods: { atproto: await signing.exportPublicKey("did") },
      alsoKnownAs: [`at://${handle}`],
      services: offered,
    }, rotation);
    const did = await deriveDidFromGenesisOp(genesis);
    if (register) await this.submit(did, genesis);
    return { did, handle, rotation, signingHex: await signing.exportPrivateKey("rawHex"), services: offered };
  }

  /** Rotates an account's signing key and returns the new public key's multibase. */
  async rotateSigningKey(target: TestDidAccount): Promise<string> {
    const signing = await Secp256k1PrivateKeyExportable.createKeypair();
    const didKey = await signing.exportPublicKey("did");
    await this.submit(target.did, await signOperation({
      type: "plc_operation",
      prev: await this.headCid(target.did),
      rotationKeys: [await target.rotation.exportPublicKey("did")],
      verificationMethods: { atproto: didKey },
      alsoKnownAs: [`at://${target.handle}`],
      services: target.services,
    }, target.rotation));
    target.signingHex = await signing.exportPrivateKey("rawHex");
    return didKey.slice("did:key:".length);
  }

  async deactivate(target: TestDidAccount): Promise<void> {
    await this.submit(target.did, await signTombstone({ type: "plc_tombstone", prev: await this.headCid(target.did) }, target.rotation));
  }

  /** A did:web account with a P-256 key, whose host serves its document. */
  async webAccount(host: string): Promise<TestWebAccount> {
    const p256 = await P256PrivateKeyExportable.createKeypair();
    const did = `did:web:${host}`;
    const document = {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      alsoKnownAs: [`at://${host}`],
      verificationMethod: [{ id: `${did}#atproto`, type: "Multikey", controller: did, publicKeyMultibase: await p256.exportPublicKey("multikey") }],
      service: [{ id: "#ship", type: "ShipService", serviceEndpoint: `https://${host}` }],
    };
    this.hosts.set(host, (request) => new URL(request.url).pathname === "/.well-known/did.json" ? Response.json(document) : new Response("Not Found", { status: 404 }));
    return { did, p256 };
  }

  /** The audit log the directory serves for a DID. */
  async auditLog(did: string): Promise<Response> {
    return await this.plc.handle(new Request(`${TEST_PLC_URL}/${did}/log/audit`));
  }

  private async submit(did: string, operation: CompatibleOperationOrTombstone): Promise<void> {
    const response = await this.plc.handle(new Request(`${TEST_PLC_URL}/${did}`, { method: "POST", body: JSON.stringify(operation) }));
    if (!response.ok) throw new Error(`The directory refused the operation: ${await response.text()}`);
  }

  private async headCid(did: string): Promise<string> {
    const log = z.array(z.object({ cid: z.string() })).parse(await (await this.auditLog(did)).json());
    const head = log.at(-1)?.cid;
    if (!head) throw new Error(`${did} has no operations`);
    return head;
  }
}

/** A service-auth token from one account to another Ship, as its PDS signs one. */
export function serviceAuthToken(from: TestDidAccount, to: { did: string }, lxm: string, now?: number): Promise<string> {
  return signServiceAuth(from.did, from.signingHex, { aud: `${to.did}#ship`, lxm }, now);
}

export function tokenClaims(from: { did: string }, to: { did: string }, lxm: string): TokenClaims {
  const iat = Math.floor(Date.now() / 1000);
  return { iss: from.did, aud: `${to.did}#ship`, lxm, iat, exp: iat + 60, jti: crypto.randomUUID() };
}

/** Signs a token by hand, with whatever header and claims a test needs. */
export async function signedJwt(header: JwtHeader, payload: TokenClaims, signer: TestDidAccount | TestWebAccount): Promise<string> {
  const segment = (value: JwtHeader | TokenClaims) => toBase64Url(new Uint8Array(new TextEncoder().encode(JSON.stringify(value))));
  const input = `${segment(header)}.${segment(payload)}`;
  const key = "p256" in signer ? signer.p256 : await Secp256k1PrivateKey.importRaw(fromHex(signer.signingHex));
  return `${input}.${toBase64Url(await key.sign(new Uint8Array(new TextEncoder().encode(input))))}`;
}

export function claimsOf(token: string): TokenClaims {
  const [, payload = ""] = token.split(".");
  return tokenClaimsSchema.parse(JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))));
}

export function randomPlcDid(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `did:plc:${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => alphabet[byte % 32]).join("")}`;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}
