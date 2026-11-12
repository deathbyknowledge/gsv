import type { z } from "zod";
import { ERROR_CODES, GsvFailure, type ErrorCode, type GsvError } from "./errors.ts";
import type { JsonValue } from "./json.ts";
import type { OpDef } from "./op.ts";
import { OPERATIONS } from "./ops.ts";

export * from "./errors.ts";
export * from "./frames.ts";
export * from "./json.ts";
export * from "./op.ts";
export * from "./ops.ts";
export { CATALOG_VERSION } from "../generated/version.ts";

type Operations = (typeof OPERATIONS)[number];
export type CatalogName = Operations["name"];
type OpNamed<N extends CatalogName> = Extract<Operations, { name: N }>;
export type Args<N extends CatalogName> = z.input<OpNamed<N>["args"]>;
export type Result<N extends CatalogName> = z.output<OpNamed<N>["result"]>;

export const CATALOG: ReadonlyMap<string, OpDef> = new Map(OPERATIONS.map(def => [def.name, def]));

/** One operation's definition with its own schemas, for callers that know the name statically. */
export function catalogOp<N extends CatalogName>(name: N): OpNamed<N> {
  // SAFETY: CATALOG is keyed by each operation's own name, so the entry for N is the definition named N.
  return CATALOG.get(name) as OpNamed<N>;
}

/** Parses a request's arguments with its operation's schema; a mismatch is `bad_request` naming the failing fields. */
export function parseArgs<A extends z.ZodType>(def: OpDef<string, A>, raw: JsonValue): z.output<A> {
  const args = def.args.safeParse(raw);
  if (args.success) return args.data;
  const issues = args.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }));
  throw new GsvFailure("bad_request", `Arguments for ${def.name} don't match the catalog.`, { details: { issues } });
}

/** Parses an answer with its operation's result schema. */
export function parseResult<N extends CatalogName>(name: N, raw: JsonValue): Result<N> {
  // SAFETY: catalogOp(name).result is the schema Result<N> is inferred from.
  return catalogOp(name).result.parse(raw) as Result<N>;
}

/** `timeout` is retryable only where repeating the call cannot repeat an effect. */
export function isRetryable(code: ErrorCode, def?: OpDef): boolean {
  const retryable = ERROR_CODES[code].retryable;
  return retryable === "catalog" ? def?.effect === "read" : retryable;
}

/** The error a client sees: the code and retryability come from the server, never the client. */
export function toGsvError(cause: unknown, def: OpDef | undefined, ref?: string): GsvError {
  const failure = GsvFailure.revive(cause);
  if (failure) {
    const error: GsvError = { code: failure.code, message: failure.message, retryable: isRetryable(failure.code, def) };
    if (failure.retryAfterMs !== undefined) error.retryAfterMs = failure.retryAfterMs;
    if (failure.details !== undefined) error.details = failure.details;
    if (ref !== undefined) error.ref = ref;
    return error;
  }
  const error: GsvError = { code: "internal", message: "Something went wrong on our side.", retryable: false };
  if (ref !== undefined) error.ref = ref;
  return error;
}
