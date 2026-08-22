import { z } from "zod";

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export type FileResourceReference = {
  type: "file";
  target: string;
  path: string;
  revision: string;
  contentType: string;
  size: number;
  expiresAt?: number;
};

export const fileResourceReferenceSchema: z.ZodType<FileResourceReference> = z.strictObject({
  type: z.literal("file"),
  target: z.string().min(1).max(256),
  path: z.string().min(1).max(8_192),
  revision: z.string().min(1).max(1_024),
  contentType: z.string().min(1).max(256),
  size: nonNegativeSafeIntegerSchema,
  expiresAt: z.optional(nonNegativeSafeIntegerSchema),
});

export type ResourceBlock = {
  type: "resource";
  ref: FileResourceReference;
};

export const resourceBlockSchema: z.ZodType<ResourceBlock> = z.strictObject({
  type: z.literal("resource"),
  ref: fileResourceReferenceSchema,
});
