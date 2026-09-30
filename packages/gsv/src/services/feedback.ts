import { z } from "zod";
import type { FeedbackActivity, SysFeedbackArgs, SysFeedbackResult } from "../protocol/syscalls/system";

export const FEEDBACK_FEATURE = "operator-feedback";
export const FEEDBACK_MAX_LENGTH = 8000;
export const FEEDBACK_ACTIVITY_MESSAGES = 20;
export const FEEDBACK_ACTIVITY_MAX_LENGTH = 64_000;
export const FEEDBACK_MAX_BODY_BYTES = 512 * 1024;

/** Report content travels in the request body, outside syscall ledger arguments. */
export type FeedbackContent = { message: string; activity?: FeedbackActivity };

export const feedbackReportSchema = z.object({
  message: z.string().trim().min(1).max(FEEDBACK_MAX_LENGTH),
  id: z.uuid().optional(),
  activity: z.object({
    pid: z.string().min(1).max(100),
    messageCount: z.number().int().min(0).max(FEEDBACK_ACTIVITY_MESSAGES),
    text: z.string().max(FEEDBACK_ACTIVITY_MAX_LENGTH),
    truncated: z.boolean(),
  }).strict().optional(),
  context: z.object({
    view: z.enum(["zen", "fleet", "memory", "people", "settings"]).optional(),
    platform: z.enum(["web", "desktop"]).optional(),
    version: z.string().max(80).optional(),
  }).strict().optional(),
}).strict();

export const feedbackArgsSchema = feedbackReportSchema.pick({ id: true, context: true }) satisfies z.ZodType<SysFeedbackArgs>;
export const feedbackContentSchema = feedbackReportSchema.omit({ id: true, context: true }) satisfies z.ZodType<FeedbackContent>;
export type FeedbackReport = SysFeedbackArgs & FeedbackContent;

export type FeedbackSubmission = FeedbackReport & {
  id: string;
  installationId: string;
  space: string | null;
  ownerUid: number;
  source: "client" | "agent";
  serverVersion: string;
};

/** Optional operator-owned inbox for reports deliberately submitted by a user. */
export interface FeedbackService {
  submitFeedback(input: FeedbackSubmission): Promise<SysFeedbackResult>;
}
