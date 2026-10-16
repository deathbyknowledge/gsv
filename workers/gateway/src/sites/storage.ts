import type { Site, SiteManifest, SitePublication } from "@humansandmachines/gsv/protocol";
import { siteManifestSchema } from "@humansandmachines/gsv/protocol";

/** Reserved from the ordinary filesystem; callers use site.* to publish. */
export const SITE_STORAGE_ROOT = "__sites";
export type SitePublishedRecord = { site: Site; publication: SitePublication; manifest: SiteManifest | null; releases: string[] };
export type SiteRelease = { siteId: string; releaseId: string; manifest: SiteManifest };
export type SiteRecordRead = { record: SitePublishedRecord; etag: string };
const MAX_RECORD_BYTES = 1024 * 1024;

export function sitePublicationKey(slug: string): string {
  return `${SITE_STORAGE_ROOT}/publications/${slug}.json`;
}

export function siteReleasePrefix(siteId: string, releaseId: string): string {
  return `${SITE_STORAGE_ROOT}/releases/${siteId}/${releaseId}/`;
}

export function siteReleaseBase(releaseId: string): string { return `/_r/${releaseId}/`; }
export function siteFileUrlPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }

export function validateSiteManifest(value: SiteManifest): SiteManifest {
  const manifest = siteManifestSchema.parse(value);
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set(manifest.files.map((file) => file.path));
  if (paths.size !== manifest.files.length) throw new Error("Release contains duplicate file paths");
  if (!paths.has(manifest.entry) || manifest.entry.includes("/") || !/\.html?$/i.test(manifest.entry)) {
    throw new Error("Release entry must be a declared HTML file at the build root");
  }
  if (manifest.image && (!paths.has(manifest.image) || !/\.(png|jpe?g|webp)$/i.test(manifest.image))) {
    throw new Error("Social image must be a declared PNG, JPEG or WebP file");
  }
  if (manifest.files.reduce((total, file) => total + file.size, 0) > 1024 * 1024 * 1024) throw new Error("Release exceeds 1 GiB");
  if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > MAX_RECORD_BYTES / 2) throw new Error("Release manifest is too large");
  return manifest;
}

export async function readSitePublication(bucket: R2Bucket, slug: string): Promise<SiteRecordRead | null> {
  const object = await bucket.get(sitePublicationKey(slug));
  if (!object) return null;
  const record = await readRecord<SitePublishedRecord>(object);
  return { record, etag: object.etag };
}

export async function readSiteRelease(bucket: R2Bucket, siteId: string, releaseId: string): Promise<SiteRelease | null> {
  const object = await bucket.get(`${siteReleasePrefix(siteId, releaseId)}manifest.json`);
  return object ? readRecord<SiteRelease>(object) : null;
}

async function readRecord<T>(object: R2ObjectBody): Promise<T> {
  if (object.size > MAX_RECORD_BYTES) {
    await object.body.cancel();
    throw new Error("Stored publication record is too large");
  }
  return object.json<T>();
}

export const siteObjectMetadata: R2PutOptions = {
  customMetadata: { uid: "0", gid: "0", mode: "400" },
};

export async function writeSitePublication(bucket: R2Bucket, record: SitePublishedRecord, expectedEtag?: string): Promise<void> {
  const written = await bucket.put(sitePublicationKey(record.site.slug), JSON.stringify(record), {
    ...siteObjectMetadata,
    httpMetadata: { contentType: "application/json" },
    onlyIf: expectedEtag ? { etagMatches: expectedEtag } : { etagDoesNotMatch: "*" },
  });
  if (!written) throw new Error("Publication changed; reload before publishing");
}
