import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  PublicBlob,
  PublicBlobRef,
  PublicCommit,
  PublicRecordWrite,
  PublicRepository,
  PublicRepositoryAccount,
} from "@humansandmachines/gsv/services/pds";

// Public repositories the deployment's PDS holds for the integration installations.
const ACCOUNTS = new Map<string, PublicRepositoryAccount>([
  ["inst_integration_first", { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "first.gsv.space", host: "https://pds.gsv.space" }],
  // Its handle is another hostname, which second.gsv.space must not claim.
  ["inst_integration_second", { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", handle: "second.ship.space", host: "https://pds.gsv.space" }],
]);
const COMMITS = new Map<string, PublicRecordWrite[][]>();
const BLOBS = new Map<string, { bytes: Uint8Array<ArrayBuffer>; mimeType: string }>();

class IntegrationRepository extends RpcTarget implements PublicRepository {
  constructor(private readonly installationId: string) { super(); }

  async ensureAccount(handle: string): Promise<PublicRepositoryAccount> {
    const account = ACCOUNTS.get(this.installationId) ?? { did: "did:plc:dddddddddddddddddddddddd", handle, host: "https://pds.gsv.space" };
    ACCOUNTS.set(this.installationId, account);
    return account;
  }

  async account(): Promise<PublicRepositoryAccount | null> {
    return ACCOUNTS.get(this.installationId) ?? null;
  }

  async serviceAuth(): Promise<string> {
    throw new Error("The integration PDS signs no Ship-to-Ship calls yet");
  }

  async applyWrites(writes: PublicRecordWrite[]): Promise<PublicCommit> {
    const account = ACCOUNTS.get(this.installationId);
    if (!account) throw new Error("RepoNotFound: this repository has no account");
    const commits = COMMITS.get(this.installationId) ?? [];
    commits.push(writes);
    COMMITS.set(this.installationId, commits);
    return {
      commit: { cid: `bafycommit${commits.length}`, rev: `rev${commits.length}` },
      results: writes.map((write) => ({
        uri: `at://${account.did}/${write.collection}/${write.rkey ?? `created${commits.length}`}`,
        cid: write.action === "delete" ? null : `bafyrecord${commits.length}`,
      })),
    };
  }

  async uploadBlob(body: ReadableStream<Uint8Array>, size: number, mimeType: string): Promise<PublicBlobRef> {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.byteLength !== size) throw new Error(`InvalidRequest: the upload ended after ${bytes.byteLength} of its declared ${size} bytes`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const cid = `bafkrei${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    BLOBS.set(`${this.installationId}/${cid}`, { bytes, mimeType });
    return { $type: "blob", ref: { $link: cid }, mimeType, size };
  }

  async readBlob(cid: string): Promise<PublicBlob | null> {
    const blob = BLOBS.get(`${this.installationId}/${cid}`);
    return blob ? { body: new Blob([blob.bytes]).stream(), mimeType: blob.mimeType, size: blob.bytes.byteLength } : null;
  }

  /** Fixture only: every batch of writes the installation committed, in order. */
  async commits(): Promise<PublicRecordWrite[][]> {
    return COMMITS.get(this.installationId) ?? [];
  }
}

export class IntegrationPds extends WorkerEntrypoint {
  async getInstallation(installationId: string): Promise<IntegrationRepository> {
    return new IntegrationRepository(installationId);
  }
}
