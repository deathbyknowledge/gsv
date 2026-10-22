import { z } from "zod";

const identity = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/);
const label = z.string().max(256);
const timestamp = z.number().int().nonnegative();
const duration = z.number().int().nonnegative().nullable();

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
    pendingApprovals: z.number().int().nonnegative(),
    lastCompactionAt: timestamp.nullable(),
  }).nullable(),
  processes: z.strictObject({
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
  }),
  runs: z.array(operatorRunSchema).max(50),
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

/**
 * Bound only to Accounts for its operator pages. Returns metadata about a
 * Ship's health and recent work: counts, timings, names and outcomes. It never
 * returns message text, tool arguments or output, prompts or file contents.
 */
export interface OperatorGatewayService {
  operatorShipSnapshot(input: OperatorShipSnapshotRequest): Promise<OperatorShipSnapshotResult>;
}
