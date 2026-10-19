import * as z from "zod/mini";

const id = z.string().check(z.minLength(1), z.maxLength(120), z.regex(/^[a-z0-9][a-z0-9._-]*$/));
export const operatorUpdateCatalogSchema = z.object({
  publisher: z.object({ id, name: z.string().check(z.minLength(1), z.maxLength(160)) }),
  updates: z.array(z.object({
    id,
    publishedAtMs: z.number().check(z.int(), z.minimum(1)),
    title: z.string().check(z.minLength(1), z.maxLength(200)),
    brief: z.string().check(z.minLength(1), z.maxLength(16_000)),
  })).check(z.maxLength(32), z.refine((updates) => new Set(updates.map((update) => update.id)).size === updates.length, "Update ids must be unique")),
});

export type OperatorUpdateCatalog = z.infer<typeof operatorUpdateCatalogSchema>;
