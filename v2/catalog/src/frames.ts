import { z } from "zod";
import { gsvErrorSchema } from "./errors.ts";

export const PROTOCOL = 5;
/** The subprotocol a socket answers with; the session token travels as a second one. */
export const SUBPROTOCOL = `gsv.${PROTOCOL}`;
export const TOKEN_SUBPROTOCOL_PREFIX = "gsv.token.";
/** No owner-socket frame carries more file bytes than this; larger content is a ticket URL. */
export const MAX_INLINE_BYTES = 64 * 1024;

export const opIdSchema = z.string().min(8).max(64);
export const feedSchema = z.string().regex(/^(events|ledger|fs:[^:]+:.+|proc:[^:]+|debug:.+)$/);
export type Feed = z.infer<typeof feedSchema>;

export const reqFrameSchema = z.object({
  t: z.literal("req"),
  id: opIdSchema,
  op: z.string(),
  args: z.unknown(),
  traceparent: z.string().optional(),
});
export const resFrameSchema = z.discriminatedUnion("ok", [
  z.object({ t: z.literal("res"), id: opIdSchema, ok: z.literal(true), result: z.unknown() }),
  z.object({ t: z.literal("res"), id: opIdSchema, ok: z.literal(false), error: gsvErrorSchema }),
]);
/** A `sig` with `seq` is a stored, replayable event; without it, an ephemeral hint carrying no data. */
export const sigFrameSchema = z.union([
  z.object({ t: z.literal("sig"), feed: feedSchema, seq: z.number().int().nonnegative(), event: z.unknown() }),
  z.object({ t: z.literal("sig"), feed: feedSchema, head: z.string() }),
]);
export const frameSchema = z.union([reqFrameSchema, resFrameSchema, sigFrameSchema]);

export type ReqFrame = z.infer<typeof reqFrameSchema>;
export type ResFrame = z.infer<typeof resFrameSchema>;
export type SigFrame = z.infer<typeof sigFrameSchema>;
export type Frame = z.infer<typeof frameSchema>;
