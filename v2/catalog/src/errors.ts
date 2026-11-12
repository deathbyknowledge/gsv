import { z } from "zod";
import { jsonObjectSchema, type JsonObject } from "./json.ts";

/** The closed list. The server sets `retryable`; clients never guess it from the code or read `message`. */
export const ERROR_CODES = {
  bad_request: { retryable: false, meaning: "Arguments failed the catalog schema" },
  unauthorized: { retryable: false, meaning: "Missing or expired token; the SDK refreshes" },
  forbidden: { retryable: false, meaning: "No grant, or a rule denied" },
  approval_denied: { retryable: false, meaning: "An approval was answered no" },
  not_found: { retryable: false, meaning: "No such resource" },
  conflict: { retryable: false, meaning: "Base revision or source changed" },
  moved: { retryable: true, meaning: "The owner moved spaces; re-resolve" },
  target_offline: { retryable: false, meaning: "The machine is offline" },
  outcome_unknown: { retryable: false, meaning: "An effect may or may not have happened" },
  quota_exhausted: { retryable: false, meaning: "Meter and resetsAt in details" },
  rate_limited: { retryable: true, meaning: "With retryAfterMs" },
  storage_full: { retryable: false, meaning: "Volume or quota full" },
  too_large: { retryable: false, meaning: "Over a size limit" },
  timeout: { retryable: "catalog", meaning: "The call's deadline passed" },
  cancelled: { retryable: false, meaning: "Cancelled by its owner" },
  unavailable: { retryable: true, meaning: "A dependency is down" },
  upgrade_required: { retryable: false, meaning: "Client below the minimum version" },
  internal: { retryable: false, meaning: "A bug; ref points at the stored diagnostic" },
} as const satisfies Record<string, { retryable: boolean | "catalog"; meaning: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;
export const errorCodeSchema = z.enum(
  // SAFETY: ERROR_CODES is a non-empty const object, so its keys are exactly the ErrorCode union.
  Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
);

export const gsvErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  ref: z.string().optional(),
  details: jsonObjectSchema.optional(),
});
export type GsvError = z.infer<typeof gsvErrorSchema>;

const failureFieldsSchema = gsvErrorSchema.pick({ code: true, retryAfterMs: true, details: true });

/** A failure an entry point answers with. Anything else thrown is `internal`. */
export class GsvFailure extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs: number | undefined;
  readonly details: JsonObject | undefined;
  constructor(code: ErrorCode, message: string, options: { retryAfterMs?: number | undefined; details?: JsonObject | undefined } = {}) {
    super(message);
    this.name = "GsvFailure";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }

  /** Workers RPC keeps an error's own fields but not its class; this restores a failure thrown in another object. */
  static revive(cause: unknown): GsvFailure | undefined {
    if (cause instanceof GsvFailure) return cause;
    if (!(cause instanceof Error) || cause.name !== "GsvFailure") return undefined;
    const fields = failureFieldsSchema.safeParse(cause);
    return fields.success ? new GsvFailure(fields.data.code, cause.message, fields.data) : undefined;
  }
}
