import { z } from "zod";
import { didSchema } from "../protocol/social";
import { REQUEST_REPORT_CATEGORIES, type RequestReportCategory } from "../protocol/syscalls/approach";

/** Message requests carry at most this much text; a report carries the same. */
export const REQUEST_REPORT_TEXT_MAX_BYTES = 32_768;

/**
 * A message request a Ship's person reported to their operator. It names the
 * sender by DID and handle, with the category and when the request arrived.
 * `message` is present only when the person chose to include it.
 */
export type RequestReportSubmission = {
  /** The reporting Ship, from the Kernel's own identity. */
  installationId: string;
  /** The Kernel's name for the request; submitting it again finds the same report. */
  requestKey: string;
  sender: { did: string; handle?: string };
  category: RequestReportCategory;
  receivedAtMs: number;
  /** The sender's name and first message, exactly as the person saw them. */
  message?: { displayName: string; text: string };
};

export type RequestReportReceipt = { reportId: string; reportedAtMs: number };

export const requestReportSubmissionSchema = z.object({
  installationId: z.string().min(1).max(160),
  requestKey: z.string().min(1).max(128),
  sender: z.object({
    did: didSchema,
    handle: z.string().min(1).max(253).optional(),
  }).strict(),
  category: z.enum(REQUEST_REPORT_CATEGORIES),
  receivedAtMs: z.number().int().positive(),
  message: z.object({
    displayName: z.string().min(1).max(80),
    text: z.string().min(1).refine((text) => new TextEncoder().encode(text).length <= REQUEST_REPORT_TEXT_MAX_BYTES, "is too long"),
  }).strict().optional(),
}).strict() satisfies z.ZodType<RequestReportSubmission>;

/** Accounts' operator queue of reported message requests. Only the Kernel's binding reaches it. */
export interface RequestReportService {
  submitRequestReport(input: RequestReportSubmission): Promise<RequestReportReceipt>;
}
