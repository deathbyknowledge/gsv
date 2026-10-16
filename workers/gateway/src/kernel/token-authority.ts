import { z } from "zod";

export const SITE_READ_CALLS = ["r12y.list", "r12y.get"] as const;
export const SITE_READ_SIGNALS = ["r12y.changed"] as const;

/** A credential can only reduce the account's authority, independently of its peer identity. */
export const siteTokenCeilingSchema = z.strictObject({
  kind: z.literal("site"),
  installationId: z.string().min(1),
  siteId: z.string().regex(/^site-[a-f0-9]{32}$/),
  origin: z.url().refine(value => new URL(value).origin === value),
  calls: z.tuple([z.literal("r12y.list"), z.literal("r12y.get")]),
  signals: z.tuple([z.literal("r12y.changed")]),
  implements: z.tuple([]),
});

export type SiteTokenCeiling = z.infer<typeof siteTokenCeilingSchema>;

export const tokenAuthoritySchema = z.strictObject({
  tokenId: z.string().min(1),
  kind: z.enum(["human", "machine", "service"]),
  peerId: z.string().nullable(),
  expiresAt: z.number().nullable(),
  ceiling: siteTokenCeilingSchema.nullable(),
});

export type TokenAuthority = z.infer<typeof tokenAuthoritySchema>;
export type TokenAudience = { installationId: string; origin: string | null };
