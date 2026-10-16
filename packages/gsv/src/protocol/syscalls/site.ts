import * as z from "zod/mini";

export const siteIdSchema = z.string().check(z.regex(/^site-[a-f0-9]{32}$/));
export const siteReleaseIdSchema = z.string().check(z.regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/));
export const siteSlugSchema = z.string().check(z.regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/));
export const siteFilePathSchema = z.string().check(z.minLength(1), z.maxLength(512), z.refine((path) =>
  // oxlint-disable-next-line no-control-regex -- Publication paths must reject control bytes at the boundary.
  !/[\\%?#\u0000-\u001f\u007f]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Expected a relative file path"));

export type SiteFile = { path: string; size: number; sha256: string };
export type SiteManifest = {
  version: 1;
  entry: string;
  routing: "static" | "spa";
  title: string;
  description: string;
  /** Optional PNG, JPEG or WebP file from this release. */
  image?: string;
  source: { repo: string; revision: string };
  files: SiteFile[];
};
export const siteManifestSchema = z.strictObject({
  version: z.literal(1),
  entry: siteFilePathSchema,
  routing: z.enum(["static", "spa"]),
  title: z.string().check(z.minLength(1), z.maxLength(160)),
  description: z.string().check(z.maxLength(400)),
  image: z.optional(siteFilePathSchema),
  source: z.strictObject({
    repo: z.string().check(z.minLength(1), z.maxLength(256)),
    revision: z.string().check(z.regex(/^[a-f0-9]{40}$/)),
  }),
  files: z.array(z.strictObject({
    path: siteFilePathSchema,
    size: z.int().check(z.nonnegative(), z.maximum(256 * 1024 * 1024)),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  })).check(z.minLength(1), z.maxLength(1024)),
}) satisfies z.ZodMiniType<SiteManifest>;

export type Site = { id: string; slug: string; origin: string; createdAtMs: number };
export type SitePublication = { revision: number; releaseId: string | null; publishedAtMs: number | null };
export type SiteCreateArgs = { slug: string };
export type SiteResult = {
  site: Site;
  publication: SitePublication;
  /** Last successfully published manifest, retained after unpublish for editing. */
  manifest: SiteManifest | null;
  shareUrl: string;
};
export type SiteGetArgs = { siteId: string };
export type SiteListArgs = Record<string, never>;
export type SiteListResult = { sites: Site[] };
export type SitePublishArgs = {
  siteId: string;
  expectedRevision: number;
  /** Choose a fresh UUID before building; the build base is /_r/<releaseId>/. */
  releaseId: string;
  /** Existing build output directory on the gsv target. */
  outputPath: string;
  manifest: SiteManifest;
};
export type SiteUnpublishArgs = { siteId: string; expectedRevision: number };

/** Public metadata for this site's own installation; contains no credentials. */
export type SiteBootstrap = {
  version: 1;
  installationId: string;
  siteId: string;
  siteOrigin: string;
  gatewayOrigin: string;
};
export type SiteAuthorizeArgs = { siteId: string };
/** Issued only by the publishing human in the trusted installation UI. */
export type SiteAuthorization = {
  token: string;
  tokenId: string;
  expiresAtMs: number;
  installationId: string;
  siteId: string;
  siteOrigin: string;
  gatewayOrigin: string;
  calls: ["r12y.list", "r12y.get"];
  signals: ["r12y.changed"];
};
