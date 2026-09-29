import { z } from "zod/mini";

const nonNegativeSafeIntegerSchema = z.int().check(z.nonnegative());

export type FileResourceReference = {
  type: "file";
  target: string;
  path: string;
  revision: string;
  contentType: string;
  size: number;
  expiresAt?: number;
};

export const fileResourceReferenceSchema: z.ZodMiniType<FileResourceReference> = z.strictObject({
  type: z.literal("file"),
  target: z.string().check(z.minLength(1), z.maxLength(256)),
  path: z.string().check(z.minLength(1), z.maxLength(8_192)),
  revision: z.string().check(z.minLength(1), z.maxLength(1_024)),
  contentType: z.string().check(z.minLength(1), z.maxLength(256)),
  size: nonNegativeSafeIntegerSchema,
  expiresAt: z.optional(nonNegativeSafeIntegerSchema),
});

export type ResourceBlock = {
  type: "resource";
  ref: FileResourceReference;
  mediaType?: "image" | "audio" | "video" | "document";
  filename?: string;
  duration?: number;
  transcription?: string;
};

export const resourceBlockSchema: z.ZodMiniType<ResourceBlock> = z.strictObject({
  type: z.literal("resource"),
  ref: fileResourceReferenceSchema,
  mediaType: z.optional(z.enum(["image", "audio", "video", "document"])),
  filename: z.optional(z.string().check(z.maxLength(1_024))),
  duration: z.optional(z.number().check(z.nonnegative())),
  transcription: z.optional(z.string()),
});
