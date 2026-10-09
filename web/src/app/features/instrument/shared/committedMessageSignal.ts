import { z } from "zod";

/* the part of a committed message the instrument reads live: who wrote it, where it belongs, and what it says */
export const committedMessageSchema = z.object({
  message: z.object({
    id: z.string(),
    conversationId: z.string(),
    sequence: z.number(),
    text: z.string(),
    createdAt: z.number(),
    /* attachments as the message carried them; the shape is the media renderer's to read */
    media: z.array(z.unknown()).optional(),
    author: z.union([
      z.object({ kind: z.literal("process"), pid: z.string() }),
      z.object({ kind: z.literal("contact"), contactId: z.string(), displayName: z.string() }),
    ]),
    /* absent on request-state lines and on messages from v1 peers */
    social: z.object({
      reference: z.object({ actor: z.object({ shipId: z.string(), subjectId: z.string() }), messageId: z.string() }),
      provenance: z.object({ kind: z.enum(["human", "process"]) }),
    }).optional(),
  }),
  directed: z.boolean().optional(),
  /* the Kernel's call for a People message: muted, blocked and ended contacts are quiet */
  attention: z.enum(["notify", "quiet"]).optional(),
});

export type CommittedMessageSignal = z.infer<typeof committedMessageSchema>;
