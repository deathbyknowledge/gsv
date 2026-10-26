import type {
  ModerationSubject,
  PublicBlobRef,
  PublicCommit,
  PublicRecordWrite,
  PublicRepositoryAccount,
  PublicTakedown,
} from "../protocol/syscalls/atproto";

export type {
  ModerationBlobRef,
  ModerationRepoRef,
  ModerationStrongRef,
  ModerationSubject,
  PublicBlobRef,
  PublicCommit,
  PublicRecordWrite,
  PublicRepositoryAccount,
  PublicTakedown,
} from "../protocol/syscalls/atproto";

/** Largest blob a repository accepts: as much as a message may attach. */
export const PUBLIC_BLOB_MAX_BYTES = 48 * 1024 * 1024;

/** One of the repository's blobs, public or still staged. */
export type PublicBlob = {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
  size: number;
};

/** One Ship-to-Ship call: the receiving Ship's DID with its `#ship` service, and one `space.ship.*` method. */
export type ShipServiceAuthRequest = { aud: string; lxm: string };

/** One installation's public ATProto repository, minted for a trusted Gateway binding. */
export interface PublicRepository {
  /** Creates the installation's did:plc and empty repository for a handle, or returns the account it already has. */
  ensureAccount(handle: string): Promise<PublicRepositoryAccount>;
  account(): Promise<PublicRepositoryAccount | null>;
  /**
   * Signs a service-auth token for one call to another Ship; it lasts about a
   * minute and a receiver accepts it once. While the host has the account taken
   * down it refuses, with an error whose message starts `RepoTakendown:`.
   */
  serviceAuth(request: ShipServiceAuthRequest): Promise<string>;
  applyWrites(writes: PublicRecordWrite[]): Promise<PublicCommit>;
  /**
   * Streams a blob of the declared size into staging, where nothing serves it
   * until a record references it; an upload no record references expires.
   */
  uploadBlob(body: ReadableStream<Uint8Array>, size: number, mimeType: string): Promise<PublicBlobRef>;
  /** Reads back one of the repository's blobs, including an upload no record references yet. */
  readBlob(cid: string): Promise<PublicBlob | null>;
  /** What the host has taken down of the repository, and why; every public read leaves it out. */
  takedowns(): Promise<PublicTakedown[]>;
  [Symbol.dispose]?(): void;
}

/** The deployment's ATProto host for public records. The installation comes from the Kernel's binding, never a caller. */
export interface PdsService {
  getInstallation(installationId: string): Promise<PublicRepository>;
}

/** com.atproto.admin.defs#statusAttr: whether a status applies, and the reference of the action that applied it. */
export type SubjectStatusAttr = { applied: boolean; ref?: string };

/**
 * com.atproto.admin.updateSubjectStatus's input, with the reason the host
 * gives the account's person. Restoring is the same call with `applied: false`.
 */
export type SubjectStatusUpdate = { subject: ModerationSubject; takedown: SubjectStatusAttr; reason?: string };

/** com.atproto.admin.getSubjectStatus's output, which updateSubjectStatus answers too. */
export type SubjectStatus = { subject: ModerationSubject; takedown: SubjectStatusAttr };

/** com.atproto.admin.getSubjectStatus's parameters: an account by DID, a record by AT URI, or a blob by its account's DID and CID. */
export type SubjectStatusQuery = { did?: string; uri?: string; blob?: string };

/** An installation's account on the open network, and what its host has taken down. */
export type RepositoryModeration = { did: string; handle: string; takedowns: PublicTakedown[] };

/** An account the deployment's host holds, found by its DID, with the installation it belongs to. */
export type HostedRepositoryModeration = RepositoryModeration & { installationId: string };

/**
 * Takedowns on the deployment's ATProto host, with the semantics of
 * com.atproto.admin.updateSubjectStatus. Only Accounts' operator binding
 * reaches it; each call names the installation whose repository holds the subject.
 */
export interface PdsModerationService {
  /** The installation's account and its takedowns; null until the installation's first outward act creates the account. */
  getRepository(installationId: string): Promise<RepositoryModeration | null>;
  updateSubjectStatus(installationId: string, input: SubjectStatusUpdate): Promise<SubjectStatus>;
  /** Null when the subject names nothing the installation's repository holds or has taken down. */
  getSubjectStatus(installationId: string, query: SubjectStatusQuery): Promise<SubjectStatus | null>;
  /** The account this host holds for a DID, and its installation; null for a DID hosted elsewhere. */
  locateRepository(did: string): Promise<HostedRepositoryModeration | null>;
  /**
   * Has the installation's account follow the state Accounts now records for
   * it, telling relays: suspended while the installation is restricted, and
   * active again once it is reactivated. Accounts calls it after each change;
   * calling it again changes nothing.
   */
  reconcileAccountStatus(installationId: string): Promise<void>;
}
