import type { JsonObject } from "../json";
import type { LexiconBlob } from "../lexicon";

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
export type PublicBlobRef = LexiconBlob;

/** The installation's ATProto account. */
export type PublicRepositoryAccount = {
  did: string;
  handle: string;
  /** Origin of the host serving the repository's public reads. */
  host: string;
  /** Set while the host has taken the account down: nothing of it is public, and it publishes and signs nothing. */
  status?: "takendown";
};

/** An account a host moderates, as com.atproto.admin.defs#repoRef names it. */
export type ModerationRepoRef = { $type: "com.atproto.admin.defs#repoRef"; did: string };
/** A record version, as com.atproto.repo.strongRef names it. A takedown covers the record's URI, whatever it later holds. */
export type ModerationStrongRef = { $type: "com.atproto.repo.strongRef"; uri: string; cid: string };
/** One of an account's blobs, as com.atproto.admin.defs#repoBlobRef names it. */
export type ModerationBlobRef = { $type: "com.atproto.admin.defs#repoBlobRef"; did: string; cid: string; recordUri?: string };
/** What a takedown covers: an account, a record or a blob, as com.atproto.admin.updateSubjectStatus names it. */
export type ModerationSubject = ModerationRepoRef | ModerationStrongRef | ModerationBlobRef;

/** Something of the Ship's that its host took down; nothing public shows it until the host restores it. */
export type PublicTakedown = {
  subject: ModerationSubject;
  /** The host's reference for the takedown, such as its operator's audit event. */
  ref: string;
  /** Why, as the host tells the person; null when it gave no reason. */
  reason: string | null;
  /** When the host took it down, in milliseconds since the epoch. */
  at: number;
};

export type AtprotoIdentityArgs = Record<string, never>;
/** The Ship's account on the open network, or null until its first publish creates it, and what its host has taken down. */
export type AtprotoIdentityResult = { identity: PublicRepositoryAccount | null; takedowns: PublicTakedown[] };

/** Up to ten changes to the Ship's public records, committed together. */
export type AtprotoWriteArgs = { writes: PublicRecordWrite[] };
export type AtprotoWriteResult = PublicCommit;

/** The request body carries the file and declares its length; nothing serves it until a record references it. */
export type AtprotoBlobUploadArgs = { mimeType: string };
export type AtprotoBlobUploadResult = { blob: PublicBlobRef };

export type AtprotoBlobReadArgs = { cid: string };
/** The response body carries the file. */
export type AtprotoBlobReadResult = { mimeType: string; size: number };
