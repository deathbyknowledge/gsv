import { WorkerEntrypoint } from "cloudflare:workers";
import { siteIdSchema, siteSlugSchema } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/services/directory";
import type { PublicationDirectoryService } from "@humansandmachines/gsv/services/publications";
import { normalizeHostname, parseBaseDomain, parseOpaqueId } from "./domain";

type PublicationEnvironment = { INSTALLATIONS_DB: D1Database; GSV_SITES_DOMAIN?: string };

export class PublicationHostStore {
  constructor(private readonly db: D1Database, private readonly domain?: string) {}

  async register(input: { installationId: string; siteId: string; slug: string }): Promise<{ origin: string }> {
    if (!this.domain) throw new Error("Site publication is not configured by this operator");
    const domain = parseBaseDomain(this.domain);
    const installationId = parseOpaqueId(input.installationId, "installationId");
    const siteId = siteIdSchema.parse(input.siteId);
    const slug = siteSlugSchema.parse(input.slug);
    const hostname = `${siteId}.${domain}`;
    if (!normalizeHostname(hostname)) throw new Error("Publication hostname is invalid");
    await this.db.prepare(`INSERT INTO publication_hostnames (hostname, installation_id, site_id, slug, created_at)
      SELECT ?, id, ?, ?, ? FROM installations WHERE id = ? AND state = 'active'
      ON CONFLICT(installation_id, site_id) DO NOTHING`)
      .bind(hostname, siteId, slug, Date.now(), installationId).run();
    const row = await this.db.prepare(`SELECT p.hostname FROM publication_hostnames p
      JOIN installations i ON i.id = p.installation_id
      WHERE p.installation_id = ? AND p.site_id = ? AND p.slug = ? AND i.state = 'active'`)
      .bind(installationId, siteId, slug).first<{ hostname: string }>();
    if (!row) throw new Error("Installation is unavailable for publication");
    return { origin: `https://${row.hostname}` };
  }

  async resolve(hostnameValue: string): Promise<InstallationDirectoryResult> {
    const hostname = normalizeHostname(hostnameValue);
    if (!hostname || !this.domain) return { found: false };
    const row = await this.db.prepare(`SELECT i.id, i.handle, i.canonical_origin, i.state, p.site_id, p.slug
      FROM publication_hostnames p JOIN installations i ON i.id = p.installation_id WHERE p.hostname = ?`)
      .bind(hostname).first<{ id: string; handle: string; canonical_origin: string;
        state: Extract<InstallationDirectoryResult, { found: true }>["state"]; site_id: string; slug: string }>();
    return row ? { found: true, installationId: row.id, handle: row.handle, canonicalOrigin: row.canonical_origin,
      state: row.state, publication: { siteId: row.site_id, slug: row.slug } } : { found: false };
  }
}

export class InstallationPublicationsEntrypoint extends WorkerEntrypoint<PublicationEnvironment, { authority: "kernel-publication" }>
  implements PublicationDirectoryService {
  async registerPublication(input: { installationId: string; siteId: string; slug: string }): Promise<{ origin: string }> {
    if (this.ctx.props?.authority !== "kernel-publication") throw new Error("Publication registration authority is not configured");
    return new PublicationHostStore(this.env.INSTALLATIONS_DB, this.env.GSV_SITES_DOMAIN).register(input);
  }
}
