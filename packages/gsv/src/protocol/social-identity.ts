import { z } from "zod/mini";

export type ActorRef = { shipId: string; subjectId: string };
export type OriginMessageRef = { actor: ActorRef; messageId: string };
export const socialIdSchema = z.string().check(z.minLength(1), z.maxLength(256));
export const actorIdSchema = z.string().check(z.minLength(1), z.maxLength(128));
export const actorRefSchema = z.strictObject({ shipId: actorIdSchema, subjectId: actorIdSchema }) satisfies z.ZodMiniType<ActorRef>;
export const originMessageRefSchema = z.strictObject({ actor: actorRefSchema, messageId: socialIdSchema }) satisfies z.ZodMiniType<OriginMessageRef>;
