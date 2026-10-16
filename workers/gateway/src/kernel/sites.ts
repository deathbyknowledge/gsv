import * as z from "zod/mini";
import type { Site, SiteCreateArgs, SiteGetArgs, SiteListResult, SitePublishArgs, SiteResult, SiteUnpublishArgs } from "@humansandmachines/gsv/protocol";
import { siteIdSchema, siteReleaseIdSchema, siteSlugSchema } from "@humansandmachines/gsv/protocol";
import { createNativeFileSystem } from "../drivers/native/filesystem";
import { inferContentType, resolveUserPath } from "../fs/utils";
import { bindStreamToAbort } from "../shared/streams";
import { readSitePublication, readSiteRelease, siteObjectMetadata, siteReleasePrefix, validateSiteManifest, writeSitePublication, type SitePublishedRecord } from "../sites/storage";
import { hasCapability } from "./capabilities";
import { requirePrincipal, resolveCallerOwnerUid, type KernelContext } from "./context";
import { handleRepoLog } from "./repo";

const revisionSchema = z.int().check(z.nonnegative());
const outputPathSchema = z.string().check(z.minLength(1), z.maxLength(2048));

export async function handleSiteCreate(args: SiteCreateArgs, ctx: KernelContext): Promise<SiteResult> {
  const ownerUid = siteOwner(ctx);
  const slug = siteSlugSchema.parse(args.slug);
  const directory = ctx.env.PUBLICATION_DIRECTORY;
  if (!directory) throw new Error("Site publication is not configured by this operator");
  if (await ctx.env.STORAGE.head(`public/${slug}`)) throw new Error("Site slug conflicts with an existing public file");
  const reserved = ctx.sites.reserve(ownerUid, slug);
  const { origin } = await directory.registerPublication({ installationId: ctx.installationId, siteId: reserved.id, slug });
  ctx.requestSignal?.throwIfAborted();
  siteOwner(ctx);
  ctx.sites.bindOrigin(reserved.id, origin);
  return handleSiteGet({ siteId: reserved.id }, ctx);
}

export function handleSiteList(ctx: KernelContext): SiteListResult {
  return { sites: ctx.sites.list(siteOwner(ctx)) };
}

export async function handleSiteGet(args: SiteGetArgs, ctx: KernelContext): Promise<SiteResult> {
  const site = ctx.sites.get(siteOwner(ctx), siteIdSchema.parse(args.siteId));
  const current = await readSitePublication(ctx.env.STORAGE, site.slug);
  return result(site, current?.record ?? null, ctx);
}

export async function handleSitePublish(args: SitePublishArgs, ctx: KernelContext): Promise<SiteResult> {
  const site = ctx.sites.get(siteOwner(ctx), siteIdSchema.parse(args.siteId));
  const expectedRevision = revisionSchema.parse(args.expectedRevision);
  const releaseId = siteReleaseIdSchema.parse(args.releaseId);
  const manifest = validateSiteManifest(args.manifest);
  const principal = requirePrincipal(ctx);
  if (!hasCapability(principal.calls, "fs.read") || !hasCapability(principal.calls, "repo.log")) {
    throw new Error("Publishing requires fs.read and repo.log capabilities");
  }
  const current = await readSitePublication(ctx.env.STORAGE, site.slug);
  if ((current?.record.publication.revision ?? 0) !== expectedRevision) throw new Error("Publication changed; reload before publishing");
  const source = await handleRepoLog({ repo: manifest.source.repo, ref: manifest.source.revision, limit: 1 }, ctx);
  if (source.entries[0]?.hash !== manifest.source.revision) throw new Error("Source revision is unavailable");
  const release = { siteId: site.id, releaseId, manifest };
  const prefix = siteReleasePrefix(site.id, releaseId);
  const stored = await readSiteRelease(ctx.env.STORAGE, site.id, releaseId);
  if (stored && JSON.stringify(stored) !== JSON.stringify(release)) throw new Error("Release ID is already bound to another manifest");
  if (!stored) {
    const reserved = await ctx.env.STORAGE.put(`${prefix}manifest.json`, JSON.stringify(release), {
      ...siteObjectMetadata, httpMetadata: { contentType: "application/json" }, onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!reserved && JSON.stringify(await readSiteRelease(ctx.env.STORAGE, site.id, releaseId)) !== JSON.stringify(release)) {
      throw new Error("Release ID is already bound to another manifest");
    }
  }
  const fs = createNativeFileSystem(ctx);
  const outputPath = await fs.realpath(resolveUserPath(outputPathSchema.parse(args.outputPath), principal.account.home, principal.account.cwd));
  if (!(await fs.stat(outputPath)).isDirectory) throw new Error("Build output must be a directory on gsv");
  for (const file of manifest.files) {
    ctx.requestSignal?.throwIfAborted();
    const key = `${prefix}files/${file.path}`;
    const existing = await ctx.env.STORAGE.head(key);
    if (existing) {
      if (existing.size !== file.size || checksumHex(existing.checksums.sha256) !== file.sha256) throw new Error("Release file differs from its manifest");
      continue;
    }
    const path = await fs.realpath(`${outputPath}/${file.path}`);
    if (!path.startsWith(`${outputPath.replace(/\/$/, "")}/`)) throw new Error("Build output symlink leaves its directory");
    const opened = await fs.openFile(path);
    if (!opened.body || opened.status !== 200 || opened.size !== file.size) {
      await opened.body?.cancel();
      throw new Error(`Build output size changed: ${file.path}`);
    }
    const body = ctx.requestSignal ? bindStreamToAbort(opened.body, ctx.requestSignal) : opened.body;
    const fixed = new FixedLengthStream(file.size);
    const copyController = new AbortController();
    const copy = body.pipeTo(fixed.writable, { signal: copyController.signal });
    const upload = ctx.env.STORAGE.put(key, fixed.readable, {
      ...siteObjectMetadata, sha256: file.sha256,
      httpMetadata: { contentType: inferContentType(file.path) },
    });
    try {
      await Promise.all([upload, copy]);
    } catch (error) {
      copyController.abort(error);
      await Promise.allSettled([upload, copy]);
      throw error;
    }
  }
  ctx.requestSignal?.throwIfAborted();
  siteOwner(ctx);
  const releases = [...new Set([...(current?.record.releases ?? []), releaseId])];
  if (releases.length > 1024) throw new Error("Site has reached its retained release limit");
  const record: SitePublishedRecord = { site, manifest, releases,
    publication: { revision: expectedRevision + 1, releaseId, publishedAtMs: Date.now() } };
  await writeSitePublication(ctx.env.STORAGE, record, current?.etag);
  return result(site, record, ctx);
}

export async function handleSiteUnpublish(args: SiteUnpublishArgs, ctx: KernelContext): Promise<SiteResult> {
  const site = ctx.sites.get(siteOwner(ctx), siteIdSchema.parse(args.siteId));
  const expectedRevision = revisionSchema.parse(args.expectedRevision);
  const current = await readSitePublication(ctx.env.STORAGE, site.slug);
  if ((current?.record.publication.revision ?? 0) !== expectedRevision) throw new Error("Publication changed; reload before unpublishing");
  ctx.requestSignal?.throwIfAborted();
  const record: SitePublishedRecord = { site, manifest: current?.record.manifest ?? null, releases: current?.record.releases ?? [],
    publication: { revision: expectedRevision + 1, releaseId: null, publishedAtMs: null } };
  await writeSitePublication(ctx.env.STORAGE, record, current?.etag);
  return result(site, record, ctx);
}

function siteOwner(ctx: KernelContext): number {
  if (requirePrincipal(ctx).kind !== "human") throw new Error("Site publication requires an owner or their process");
  return resolveCallerOwnerUid(ctx);
}

function result(site: Site, record: SitePublishedRecord | null, ctx: KernelContext): SiteResult {
  if (!ctx.installationIdentity) throw new Error("Installation identity is unavailable");
  if (record && record.site.id !== site.id) throw new Error("Publication identity changed");
  return { site, publication: record?.publication ?? { revision: 0, releaseId: null, publishedAtMs: null },
    manifest: record?.manifest ?? null,
    shareUrl: new URL(`/public/${site.slug}`, ctx.installationIdentity.canonicalOrigin).href };
}

function checksumHex(value: ArrayBuffer | undefined): string {
  return value ? [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : "";
}
