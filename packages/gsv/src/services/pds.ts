import type { JsonObject } from "../protocol/json";

/** One change to an installation's public repository; every write in a call lands in one signed commit. */
export type PublicRecordWrite =
  | { action: "create"; collection: string; rkey?: string; record: JsonObject }
  | { action: "put"; collection: string; rkey: string; record: JsonObject }
  | { action: "delete"; collection: string; rkey: string };

export type PublicCommit = {
  commit: { cid: string; rev: string };
  /** One entry per write, in order; a delete has no record CID. */
  results: Array<{ uri: string; cid: string | null }>;
};

/** Largest blob a repository accepts: as much as a message may attach. */
export const PUBLIC_BLOB_MAX_BYTES = 48 * 1024 * 1024;

/** A blob as a record references it once uploaded. */
export type PublicBlobRef = {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
};

/** The installation's ATProto account. */
export type PublicRepositoryAccount = {
  did: string;
  handle: string;
  /** Origin of the host serving the repository's public reads. */
  host: string;
};

/** One of the repository's blobs, public or still staged. */
export type PublicBlob = {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  size: number;
};

/** One installation's public ATProto repository, minted for a trusted Gateway binding. */
export interface PublicRepository {
  /** Creates the installation's did:plc and empty repository for a handle, or returns the account it already has. */
  ensureAccount(handle: string): Promise<PublicRepositoryAccount>;
  account(): Promise<PublicRepositoryAccount | null>;
  applyWrites(writes: PublicRecordWrite[]): Promise<PublicCommit>;
  /**
   * Streams a blob of the declared size into staging, where nothing serves it
   * until a record references it; an upload no record references expires.
   */
  uploadBlob(body: ReadableStream<Uint8Array>, size: number, mimeType: string): Promise<PublicBlobRef>;
  /** Reads back one of the repository's blobs, including an upload no record references yet. */
  readBlob(cid: string): Promise<PublicBlob | null>;
  [Symbol.dispose]?(): void;
}

/** The deployment's ATProto host for public records. The installation comes from the Kernel's binding, never a caller. */
export interface PdsService {
  getInstallation(installationId: string): Promise<PublicRepository>;
}
