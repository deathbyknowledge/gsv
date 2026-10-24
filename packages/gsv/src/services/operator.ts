import { z } from "zod";
import { DID_PATTERN } from "../protocol/social";

const identity = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/);
const label = z.string().max(256);
const timestamp = z.number().int().nonnegative();
const duration = z.number().int().nonnegative().nullable();
const count = z.number().int().nonnegative();

export const operatorShipSnapshotRequestSchema = z.strictObject({
  version: z.literal(1),
  installationId: identity,
  /** How many of the Ship's most recent runs to describe, newest first. */
  runLimit: z.number().int().min(1).max(50),
});
export type OperatorShipSnapshotRequest = z.infer<typeof operatorShipSnapshotRequestSchema>;

export const operatorRunStepSchema = z.strictObject({
  kind: z.enum(["inference", "tool", "delivery"]),
  /** A tool, model or delivery name; never arguments or output. */
  name: label,
  /** Where a tool ran: `gsv`, a device label such as `Device 1`, or `Other device`; never a device's own name. */
  target: label.optional(),
  startedAt: timestamp,
  durationMs: duration,
  status: z.enum(["ok", "error", "cancelled", "running"]),
});
export type OperatorRunStep = z.infer<typeof operatorRunStepSchema>;

export const operatorRunSchema = z.strictObject({
  runId: label,
  /** Where the input came from: a messenger, a client, a schedule or Kernel work. */
  origin: z.enum(["adapter", "client", "schedule", "event", "ipc", "other"]),
  /** The input's length in characters; never its content. */
  inputChars: z.number().int().nonnegative().nullable(),
  inputHasMedia: z.boolean(),
  startedAt: timestamp,
  durationMs: duration,
  status: z.enum(["ok", "error", "aborted", "running"]),
  steps: z.array(operatorRunStepSchema).max(200),
});
export type OperatorRun = z.infer<typeof operatorRunSchema>;

export const operatorShipSnapshotSchema = z.strictObject({
  version: z.literal(1),
  installationId: identity,
  capturedAt: timestamp,
  ship: z.strictObject({
    pid: label,
    state: label,
    lastActiveAt: timestamp.nullable(),
    activeRunId: label.nullable(),
    queuedCount: z.number().int().nonnegative(),
    /** Null, like `runs`, when the Ship's Process could not be read. */
    pendingApprovals: z.number().int().nonnegative().nullable(),
    lastCompactionAt: timestamp.nullable(),
  }).nullable(),
  processes: z.strictObject({
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
  }),
  /** Newest first; null when the Ship's Process could not be read, never an empty stand-in. */
  runs: z.array(operatorRunSchema).max(50).nullable(),
  messengers: z.array(z.strictObject({
    adapter: label,
    linkedAt: timestamp.nullable(),
  })).max(50),
  targets: z.array(z.strictObject({
    /** `Device 1`, `Device 2`… numbered by first connection; never a device's own name. */
    id: label,
    online: z.boolean(),
    lastSeenAt: timestamp.nullable(),
  })).max(50),
  shipEvents: z.strictObject({
    queued: z.number().int().nonnegative(),
    oldestQueuedAt: timestamp.nullable(),
  }),
  openResponsibilities: z.number().int().nonnegative(),
});
export type OperatorShipSnapshot = z.infer<typeof operatorShipSnapshotSchema>;

export type OperatorShipSnapshotResult =
  | { found: true; snapshot: OperatorShipSnapshot }
  | { found: false };

/** The most people one Ship's rows may name the old way; a Ship with more fails its survey. */
export const MAX_IDENTITY_MOVE_PEOPLE = 10_000;
const legacyId = z.string().min(1).max(128);

/** How Ships named a person before DIDs: their Ship's key, and their account's subject on it. */
export const operatorLegacyPersonSchema = z.strictObject({ shipId: legacyId, subjectId: legacyId });
export type OperatorLegacyPerson = z.infer<typeof operatorLegacyPersonSchema>;

/** A person named the old way, the DID that names them now, and the handle that DID names. */
export const operatorPersonDidSchema = z.strictObject({
  shipId: legacyId,
  subjectId: legacyId,
  did: z.string().max(2_048).regex(DID_PATTERN),
  handle: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
});
export type OperatorPersonDid = z.infer<typeof operatorPersonDidSchema>;

/** Rows that name people the old way: contacts, blocks, message requests and deliveries. */
const identityRowCountsSchema = z.strictObject({
  contacts: count,
  blocks: count,
  requests: count,
  deliveries: count,
});

export const operatorIdentitySurveyRequestSchema = z.strictObject({
  version: z.literal(1),
  installationId: identity,
});
export type OperatorIdentitySurveyRequest = z.infer<typeof operatorIdentitySurveyRequestSchema>;

export const operatorIdentitySurveySchema = z.strictObject({
  version: z.literal(1),
  installationId: identity,
  /**
   * How other Ships named this Ship's person, with the DID that replaces it.
   * Null once the Ship has moved, or when it never had a contact.
   */
  person: operatorPersonDidSchema.nullable(),
  /** Everyone the Ship's waiting rows name. */
  references: z.array(operatorLegacyPersonSchema).max(MAX_IDENTITY_MOVE_PEOPLE),
  waiting: identityRowCountsSchema,
  /** Contacts of an account other than the Ship's person, which the move ends. */
  otherAccounts: count,
});
export type OperatorIdentitySurvey = z.infer<typeof operatorIdentitySurveySchema>;

export type OperatorIdentitySurveyResult =
  | { found: true; survey: OperatorIdentitySurvey }
  | { found: false };

export const operatorIdentityMoveRequestSchema = z.strictObject({
  version: z.literal(1),
  installationId: identity,
  /** Each person the survey named whose Ship is on this deployment, the Ship's own person included. */
  people: z.array(operatorPersonDidSchema).max(MAX_IDENTITY_MOVE_PEOPLE + 1),
});
export type OperatorIdentityMoveRequest = z.infer<typeof operatorIdentityMoveRequestSchema>;

const movedRowCountsSchema = identityRowCountsSchema.extend({ messages: count });

export const operatorIdentityMoveSchema = z.strictObject({
  version: z.literal(1),
  installationId: identity,
  /** Rows that now name people by DID, conversation messages included. */
  moved: movedRowCountsSchema,
  /**
   * Rows naming someone with no DID here, which the move ended: a person on
   * another deployment, who must reconnect, or another account's contact.
   */
  ended: movedRowCountsSchema,
});
export type OperatorIdentityMove = z.infer<typeof operatorIdentityMoveSchema>;

export type OperatorIdentityMoveResult =
  | { found: true; move: OperatorIdentityMove }
  | { found: false };

/**
 * Bound only to Accounts for its operator pages. Returns metadata about a
 * Ship's health and recent work: counts, timings, names and outcomes. It never
 * returns message text, tool arguments or output, prompts or file contents.
 */
export interface OperatorGatewayService {
  operatorShipSnapshot(input: OperatorShipSnapshotRequest): Promise<OperatorShipSnapshotResult>;
  /**
   * Before the move to DIDs: the Ship's own old and new names, and the people
   * its rows still name the old way. Gives the Ship its DID if it had contacts,
   * and writes a profile published before profiles were records to its repository.
   */
  operatorIdentitySurvey(input: OperatorIdentitySurveyRequest): Promise<OperatorIdentitySurveyResult>;
  /**
   * Names the people in the Ship's contacts, blocks, message requests,
   * deliveries and contact conversations by DID, and ends the rows naming
   * anyone else. Repeating a finished move changes nothing.
   */
  operatorIdentityMove(input: OperatorIdentityMoveRequest): Promise<OperatorIdentityMoveResult>;
}
