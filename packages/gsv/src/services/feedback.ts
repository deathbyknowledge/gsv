import { z } from "zod";
import type { SysFeedbackArgs, SysFeedbackResult } from "../protocol/syscalls/system";

export const FEEDBACK_FEATURE = "operator-feedback";
export const FEEDBACK_MAX_LENGTH = 8000;
export const FEEDBACK_ACTIVITY_MESSAGES = 20;
export const FEEDBACK_ACTIVITY_MAX_LENGTH = 64_000;

export const feedbackArgsSchema: z.ZodType<SysFeedbackArgs> = z.object({
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

export type FeedbackSubmission = SysFeedbackArgs & {
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
