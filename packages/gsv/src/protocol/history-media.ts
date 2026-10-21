import * as z from "zod/mini";
import { resourceBlockSchema, type ResourceBlock } from "./resource";
import type { ProcMediaInput } from "./syscalls/proc";

const historyLegacyMediaSchema: z.ZodMiniType<ProcMediaInput & { description?: string; revision?: string }> = z.strictObject({
  type: z.enum(["image", "audio", "video", "document"]),
  mimeType: z.string(),
  key: z.optional(z.string()),
  conversationId: z.optional(z.string()),
  path: z.optional(z.string()),
  url: z.optional(z.string()),
  filename: z.optional(z.string()),
  // Match the finite numbers accepted by legacy ingress and stored descriptors.
  size: z.optional(z.number()),
  duration: z.optional(z.number()),
  transcription: z.optional(z.string()),
  description: z.optional(z.string()),
  revision: z.optional(z.string()),
});

export type ProcHistoryMedia = ResourceBlock | (ProcMediaInput & { description?: string; revision?: string });
export const procHistoryMediaSchema: z.ZodMiniType<ProcHistoryMedia> = z.union([resourceBlockSchema, historyLegacyMediaSchema]);
