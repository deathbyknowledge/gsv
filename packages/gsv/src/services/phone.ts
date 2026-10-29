import { z } from "zod";
import type { BinaryBody } from "../protocol/body";
import type {
  PhoneBrief, SysPhoneAnswerArgs, SysPhoneAnswerResult, SysPhoneCallArgs, SysPhoneCallResult,
  SysPhoneEndResult, SysPhoneGetResult, SysPhoneJoinResult, SysPhoneListArgs, SysPhoneListResult,
  SysPhoneNoteArgs, SysPhoneNoteResult, SysPhoneWatchResult,
} from "../protocol/syscalls/phone";

const id = z.string().trim().min(1).max(160);
const line = (max: number) => z.string().trim().min(1).max(max);

export const PHONE_MAX_CALL_MINUTES = 30;
export const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{6,14}$/;

export const phoneBriefSchema = z.strictObject({
  to: z.string().regex(PHONE_NUMBER_PATTERN, "Use an international number such as +34910000000"),
  business: line(120).optional(),
  onBehalfOf: line(100),
  goal: line(1000),
  mayShare: z.array(line(300)).max(12).optional(),
  mustNot: z.array(line(300)).max(12).optional(),
  ifOutsideLimits: z.enum(["ask", "end"]).optional(),
  voicemail: z.enum(["hang_up", "leave_message"]).optional(),
  language: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/).optional(),
  maxMinutes: z.number().int().min(1).max(PHONE_MAX_CALL_MINUTES).optional(),
}) satisfies z.ZodType<PhoneBrief>;

export const phoneActorSchema = z.strictObject({
  ownerUid: z.number().int().nonnegative(),
  human: z.boolean(),
  processId: id.optional(),
});
export type PhoneActor = z.infer<typeof phoneActorSchema>;

export const phoneCallSchema = z.strictObject({
  requestId: id,
  brief: phoneBriefSchema,
  responsibilityId: id.optional(),
}) satisfies z.ZodType<SysPhoneCallArgs>;
export const phoneSelectorSchema = z.strictObject({ callId: id });
export const phoneListSchema = z.strictObject({ includeEnded: z.boolean().optional() }) satisfies z.ZodType<SysPhoneListArgs>;
export const phoneAnswerSchema = z.strictObject({ callId: id, questionId: id, answer: line(1000) }) satisfies z.ZodType<SysPhoneAnswerArgs>;
export const phoneNoteSchema = z.strictObject({ callId: id, note: line(1000) }) satisfies z.ZodType<SysPhoneNoteArgs>;

/**
 * Identity only. The Kernel reads the call through its capability before acting,
 * so a replayed or stale notification cannot carry content of its own.
 */
export const phoneChangeSchema = z.strictObject({
  installationId: id,
  ownerUid: z.number().int().nonnegative(),
  callId: id,
  revision: z.number().int().positive(),
  event: z.enum(["changed", "asked", "ended"]),
});
export type PhoneChange = z.infer<typeof phoneChangeSchema>;

/** Voice agent instructions rendered by the Kernel from its protected template and the approved brief. */
export const phoneInstructionsSchema = z.string().trim().min(1).max(32_000);

export type PhoneRealtimeSessionRequest = { installationId: string; callId: string; model: string };
/** A short-lived credential for one realtime model session; the provider key never leaves inference. */
export type PhoneRealtimeSession = { provider: "openai"; model: string; url: string; clientSecret: string; expiresAt: number };

/** Inference-owned realtime credential minting, bound only to the calls service. */
export interface PhoneRealtimeSessions {
  createRealtimeSession(input: PhoneRealtimeSessionRequest): Promise<PhoneRealtimeSession>;
}

/** Deployment-authorized notifications from the calls service to the owning Kernel. */
export interface PhoneGatewayService {
  phoneChanged(change: PhoneChange): Promise<void>;
}

/** Identity is supplied by Kernel, never copied from public syscall arguments. */
export interface InstallationPhone {
  call(actor: PhoneActor, args: SysPhoneCallArgs, instructions: string): Promise<SysPhoneCallResult>;
  get(actor: PhoneActor, callId: string): Promise<SysPhoneGetResult>;
  list(actor: PhoneActor, args: SysPhoneListArgs): Promise<SysPhoneListResult>;
  answer(actor: PhoneActor, args: SysPhoneAnswerArgs): Promise<SysPhoneAnswerResult>;
  note(actor: PhoneActor, args: SysPhoneNoteArgs): Promise<SysPhoneNoteResult>;
  end(actor: PhoneActor, callId: string): Promise<SysPhoneEndResult>;
  watch(actor: PhoneActor, callId: string): Promise<{ data: SysPhoneWatchResult; body: BinaryBody }>;
  join(actor: PhoneActor, callId: string): Promise<SysPhoneJoinResult>;
  /** The Kernel filed the transcript; the service may drop its copy. */
  transcriptFiled(actor: PhoneActor, callId: string, path: string): Promise<void>;
  [Symbol.dispose]?(): void;
}

/** Optional service capability acquired only from a trusted Gateway binding. */
export interface PhoneService {
  getInstallation(installationId: string): Promise<InstallationPhone>;
}
