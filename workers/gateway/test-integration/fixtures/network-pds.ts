import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { deriveDidFromGenesisOp, signOperation, signTombstone } from "@atcute/did-plc";
import { toBase32 } from "@atcute/multibase";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { signServiceAuth } from "@humansandmachines/gsv-pds/src/host/service-auth";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import type {
  PublicBlob,
  PublicBlobRef,
  PublicCommit,
  PublicRecordWrite,
  PublicRepository,
  PublicRepositoryAccount,
  ShipServiceAuthRequest,
} from "@humansandmachines/gsv/services/pds";

/** The test network's DID directory, which the integration test serves. */
const PLC_URL = "https://plc.test";

type NetworkAccount = PublicRepositoryAccount & { signingHex: string; rotation: Secp256k1PrivateKeyExportable };

const ACCOUNTS = new Map<string, NetworkAccount>();
const CREATING = new Map<string, Promise<NetworkAccount>>();
const RECORDS = new Map<string, { cid: string; value: JsonObject }>();
const BLOBS = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mimeType: string }>();

/**
 * A repository host on the test network, as the Ship's PDS is in production:
 * the first outward act registers a did:plc for the Ship's handle, with this
 * host at `pds.<domain>` and the Ship's methods at its handle. It signs the
 * Ship's calls with that DID's key and serves the records the Ship publishes.
 */
class NetworkRepository extends RpcTarget implements PublicRepository {
  constructor(private readonly installationId: string) { super(); }

  async ensureAccount(handle: string): Promise<PublicRepositoryAccount> {
    const existing = ACCOUNTS.get(this.installationId);
    if (existing) return publicAccount(existing);
    let creating = CREATING.get(this.installationId);
    if (!creating) {
      creating = registerAccount(handle.toLowerCase()).finally(() => CREATING.delete(this.installationId));
      CREATING.set(this.installationId, creating);
    }
    const account = await creating;
    ACCOUNTS.set(this.installationId, account);
    return publicAccount(account);
  }

  async account(): Promise<PublicRepositoryAccount | null> {
    const account = ACCOUNTS.get(this.installationId);
    return account ? publicAccount(account) : null;
  }

  async serviceAuth(request: ShipServiceAuthRequest): Promise<string> {
    const account = this.requireAccount();
    return await signServiceAuth(account.did, account.signingHex, request);
  }

  async applyWrites(writes: PublicRecordWrite[]): Promise<PublicCommit> {
    const account = this.requireAccount();
    const results = await Promise.all(writes.map(async (write) => {
      const uri = `at://${account.did}/${write.collection}/${write.rkey ?? crypto.randomUUID()}`;
      if (write.action === "delete") {
        RECORDS.delete(uri);
        return { uri, cid: null };
      }
      const cid = await contentId(new TextEncoder().encode(JSON.stringify(write.record)));
      RECORDS.set(uri, { cid, value: write.record });
      return { uri, cid };
    }));
    return { commit: { cid: await contentId(new TextEncoder().encode(JSON.stringify(results))), rev: String(Date.now()) }, results };
  }

  async uploadBlob(body: ReadableStream<Uint8Array>, size: number, mimeType: string): Promise<PublicBlobRef> {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.byteLength !== size) throw new Error(`InvalidRequest: the upload ended after ${bytes.byteLength} of its declared ${size} bytes`);
    const cid = await contentId(bytes);
    BLOBS.set(`${this.installationId}/${cid}`, { bytes, mimeType });
    return { $type: "blob", ref: { $link: cid }, mimeType, size };
  }

  async readBlob(cid: string): Promise<PublicBlob | null> {
    const blob = BLOBS.get(`${this.installationId}/${cid}`);
    return blob ? { body: new Blob([blob.bytes]).stream(), mimeType: blob.mimeType, size: blob.bytes.byteLength } : null;
  }

  private requireAccount(): NetworkAccount {
    const account = ACCOUNTS.get(this.installationId);
    if (!account) throw new Error("RepoNotFound: this repository has no account");
    return account;
  }
}

export class NetworkPds extends WorkerEntrypoint {
  async getInstallation(installationId: string): Promise<NetworkRepository> {
    return new NetworkRepository(installationId);
  }
}

/** Tombstones every DID this host registered, as erasing a deleted space's repository does. */
export async function eraseNetworkIdentities(): Promise<void> {
  for (const account of ACCOUNTS.values()) {
    const log = await (await fetch(`${PLC_URL}/${account.did}/log/audit`)).json<{ cid: string }[]>();
    const prev = log.at(-1)?.cid;
    if (!prev) throw new Error(`${account.did} has no operations`);
    const response = await fetch(`${PLC_URL}/${account.did}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await signTombstone({ type: "plc_tombstone", prev }, account.rotation)),
    });
    if (!response.ok) throw new Error(`The test directory refused the tombstone for ${account.did}: ${await response.text()}`);
  }
}

/** Answers `com.atproto.repo.getRecord` as a repository host does, with a 400 for a record it doesn't hold. */
export function serveNetworkRecord(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const uri = `at://${params.get("repo")}/${params.get("collection")}/${params.get("rkey")}`;
  const record = RECORDS.get(uri);
  if (!record) return Response.json({ error: "RecordNotFound", message: "Could not locate record" }, { status: 400 });
  return Response.json({ uri, cid: record.cid, value: record.value });
}

async function registerAccount(handle: string): Promise<NetworkAccount> {
  const host = `https://pds.${handle.slice(handle.indexOf(".") + 1)}`;
  const rotation = await Secp256k1PrivateKeyExportable.createKeypair();
  const signing = await Secp256k1PrivateKeyExportable.createKeypair();
  const genesis = await signOperation({
    type: "plc_operation",
    prev: null,
    rotationKeys: [await rotation.exportPublicKey("did")],
    verificationMethods: { atproto: await signing.exportPublicKey("did") },
    alsoKnownAs: [`at://${handle}`],
    services: {
      atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: host },
      ship: { type: "ShipService", endpoint: `https://${handle}` },
    },
  }, rotation);
  const did = await deriveDidFromGenesisOp(genesis);
  const response = await fetch(`${PLC_URL}/${did}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(genesis),
  });
  if (!response.ok) throw new Error(`The test directory refused ${did}: ${await response.text()}`);
  return { did, handle, host, signingHex: await signing.exportPrivateKey("rawHex"), rotation };
}

function publicAccount({ did, handle, host }: NetworkAccount): PublicRepositoryAccount {
  return { did, handle, host };
}

/** Stands in for a CID: different content has a different one. */
async function contentId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `b${toBase32(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}
