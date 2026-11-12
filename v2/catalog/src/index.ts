import type { z } from "zod";
import { ERROR_CODES, GsvFailure, type ErrorCode, type GsvError } from "./errors.ts";
import type { OpDef } from "./op.ts";
import { OPERATIONS } from "./ops.ts";

export * from "./errors.ts";
export * from "./frames.ts";
export * from "./op.ts";
export * from "./ops.ts";
export { CATALOG_VERSION } from "../generated/version.ts";

type Operations = (typeof OPERATIONS)[number];
export type CatalogName = Operations["name"];
type OpNamed<N extends CatalogName> = Extract<Operations, { name: N }>;
export type Args<N extends CatalogName> = z.input<OpNamed<N>["args"]>;
export type Result<N extends CatalogName> = z.output<OpNamed<N>["result"]>;

export const CATALOG: ReadonlyMap<string, OpDef> = new Map(OPERATIONS.map(def => [def.name, def]));

/** `timeout` is retryable only where repeating the call cannot repeat an effect. */
export function isRetryable(code: ErrorCode, def?: OpDef): boolean {
  const retryable = ERROR_CODES[code].retryable;
  return retryable === "catalog" ? def?.effect === "read" : retryable;
}

/** The error a client sees: the code and retryability come from the server, never the client. */
export function toGsvError(cause: unknown, def: OpDef | undefined, ref?: string): GsvError {
  const failure = GsvFailure.revive(cause);
  if (failure) {
    return {
      code: failure.code,
      message: failure.message,
      retryable: isRetryable(failure.code, def),
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      ...(ref === undefined ? {} : { ref }),
      ...(failure.details === undefined ? {} : { details: failure.details }),
    };
  }
  return { code: "internal", message: "Something went wrong on our side.", retryable: false, ...(ref === undefined ? {} : { ref }) };
}
