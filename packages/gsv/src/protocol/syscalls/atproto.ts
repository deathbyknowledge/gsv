import type { JsonObject } from "../json";

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

export type AtprotoIdentityArgs = Record<string, never>;
/** The Ship's account on the open network, or null until its first publish creates it. */
export type AtprotoIdentityResult = { identity: PublicRepositoryAccount | null };

/** Up to ten changes to the Ship's public records, committed together. */
export type AtprotoWriteArgs = { writes: PublicRecordWrite[] };
export type AtprotoWriteResult = PublicCommit;

/** The request body carries the file and declares its length; nothing serves it until a record references it. */
export type AtprotoBlobUploadArgs = { mimeType: string };
export type AtprotoBlobUploadResult = { blob: PublicBlobRef };

export type AtprotoBlobReadArgs = { cid: string };
/** The response body carries the file. */
export type AtprotoBlobReadResult = { mimeType: string; size: number };
