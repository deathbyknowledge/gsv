import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  PdsModerationService,
  RepositoryModeration,
  SubjectStatus,
  SubjectStatusQuery,
  SubjectStatusUpdate,
} from "@humansandmachines/gsv/services/pds";
import * as z from "zod/mini";
import type { HostedRepo } from "../host/repo";
import type { PdsEnv } from "./env";

const identifier = z.string().check(z.minLength(1), z.maxLength(2_048));
const subjectSchema = z.discriminatedUnion("$type", [
  z.strictObject({ $type: z.literal("com.atproto.admin.defs#repoRef"), did: identifier }),
  z.strictObject({ $type: z.literal("com.atproto.repo.strongRef"), uri: identifier, cid: identifier }),
  z.strictObject({ $type: z.literal("com.atproto.admin.defs#repoBlobRef"), did: identifier, cid: identifier, recordUri: z.optional(identifier) }),
]);
const updateSchema = z.strictObject({
  subject: subjectSchema,
  takedown: z.strictObject({ applied: z.boolean(), ref: z.optional(z.string().check(z.minLength(1), z.maxLength(256))) }),
  reason: z.optional(z.string().check(z.maxLength(500))),
});
const querySchema = z.strictObject({ did: z.optional(identifier), uri: z.optional(identifier), blob: z.optional(identifier) });

/**
 * Bound only to Accounts, with the operator's moderation authority. Each call
 * names the installation whose repository holds the subject; the repository
 * keeps the takedown, every public read honours it, and the installation's
 * person reads it back with the reason the operator gave.
 */
export class PdsModerationEntrypoint extends WorkerEntrypoint<PdsEnv, { authority: "operator-moderation" }> implements PdsModerationService {
  async getRepository(installationId: string): Promise<RepositoryModeration | null> {
    const repo = await this.repository(installationId);
    const account = await repo.account();
    return account ? { did: account.did, handle: account.handle, takedowns: await repo.takedowns() } : null;
  }

  async updateSubjectStatus(installationId: string, input: SubjectStatusUpdate): Promise<SubjectStatus> {
    const repo = await this.repository(installationId);
    return await repo.updateSubjectStatus(updateSchema.parse(input));
  }

  async getSubjectStatus(installationId: string, query: SubjectStatusQuery): Promise<SubjectStatus | null> {
    const repo = await this.repository(installationId);
    return await repo.getSubjectStatus(querySchema.parse(query));
  }

  /** The installation's repository object, once the binding's authority and Accounts' record of the installation allow it. */
  private async repository(installationId: string): Promise<DurableObjectStub<HostedRepo>> {
    if (this.ctx.props?.authority !== "operator-moderation") throw new Error("PDS moderation authority is required");
    if (!installationId || installationId.length > 160) throw new Error("Invalid installation identity");
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!route.found || route.installationId !== installationId) throw new Error("Unknown installation");
    return this.env.REPOS.getByName(installationId);
  }
}
