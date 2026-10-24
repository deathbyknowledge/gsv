import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationState } from "@humansandmachines/gsv/services/directory";
import {
  installationDeletionRequestSchema,
  type InstallationDeletionReceipt,
  type InstallationDeletionRequest,
  type InstallationDeletionService,
} from "@humansandmachines/gsv/services/lifecycle";
import {
  installationDeletionInspectionSchema,
  type InstallationDeletionInspection,
  type InstallationDeletionInspectionResult,
  type InstallationResourceObservation,
} from "@humansandmachines/gsv/services/lifecycle-discovery";
import { FIREHOSE_NAME } from "../host/firehose";
import type { RetirementStatus } from "../host/repo";
import type { PdsEnv } from "./env";

/** States in which Accounts has retired an installation; only these admit deleting it. */
const RETIRED: ReadonlySet<InstallationState> = new Set(["retained", "deleting", "deleted"]);

// Cloudflare SQLite Durable Object backups retain the preceding 30 days.
// The extra minute keeps the receipt outside the boundary's clock precision.
const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60_000 + 60_000;

type Resource = InstallationDeletionInspection["resources"][number];

/**
 * Bound only to Accounts, with deletion authority. Each installation's
 * repository object carries out its own deletion and has the host firehose
 * forget it on the way.
 */
export class PdsLifecycleEntrypoint extends WorkerEntrypoint<PdsEnv, { authority?: string }> implements InstallationDeletionService {
  async quiesceInstallation(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = await this.authorize(value);
    return receipt(input, await this.env.REPOS.getByName(input.installationId).retire(input.operationId));
  }

  async eraseInstallation(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = await this.authorize(value);
    return receipt(input, await this.env.REPOS.getByName(input.installationId).erase(input.operationId));
  }

  async installationDeletionStatus(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = await this.authorize(value);
    return receipt(input, await this.env.REPOS.getByName(input.installationId).retirementStatus(input.operationId));
  }

  async inspectInstallationDeletion(value: InstallationDeletionInspection): Promise<InstallationDeletionInspectionResult> {
    this.authority();
    const input = installationDeletionInspectionSchema.parse(value);
    await this.requireRetired(input.installationId);
    const observations: InstallationResourceObservation[] = [];
    for (const resource of input.resources) {
      if (resource.kind === "pds-host") observations.push(await this.inspectHost(resource, input.installationId));
      else if (resource.kind === "pds-repository") observations.push(await this.inspectRepository(resource));
      else throw new Error("Resource kind is not owned by the PDS");
    }
    return { installationId: input.installationId, observations };
  }

  /** The host's one firehose object holds an installation's data while it lists the installation's repository. */
  private async inspectHost(resource: Resource, installationId: string): Promise<InstallationResourceObservation> {
    if (resource.objectId !== this.env.FIREHOSE.idFromName(FIREHOSE_NAME).toString()
      || (resource.name !== undefined && resource.name !== FIREHOSE_NAME)) {
      return { ...resource, outcome: "unidentified" };
    }
    const outcome = await this.env.FIREHOSE.getByName(FIREHOSE_NAME).inspectRepository(installationId);
    if (outcome === "identified") return { ...resource, name: FIREHOSE_NAME, outcome, installationId };
    return outcome === "unrelated" ? { ...resource, name: FIREHOSE_NAME, outcome } : { ...resource, outcome };
  }

  /** A repository object names the installation it belongs to, which Accounts must know by the same identity. */
  private async inspectRepository(resource: Resource): Promise<InstallationResourceObservation> {
    const { name, holds } = await this.env.REPOS.get(this.env.REPOS.idFromString(resource.objectId)).holding();
    if (name === null) return { ...resource, outcome: holds ? "unidentified" : "empty" };
    if (this.env.REPOS.idFromName(name).toString() !== resource.objectId || (resource.name !== undefined && resource.name !== name)) {
      return { ...resource, outcome: "unidentified" };
    }
    if (!holds) return { ...resource, outcome: "empty" };
    const known = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(name);
    return known.found && known.installationId === name
      ? { ...resource, name, outcome: "identified", installationId: name }
      : { ...resource, outcome: "unidentified" };
  }

  private authority(): void {
    if (this.ctx.props?.authority !== "installation-deletion") throw new Error("PDS deletion authority is required");
  }

  private async authorize(value: InstallationDeletionRequest): Promise<InstallationDeletionRequest> {
    this.authority();
    const input = installationDeletionRequestSchema.parse(value);
    await this.requireRetired(input.installationId);
    return input;
  }

  private async requireRetired(installationId: string): Promise<void> {
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!route.found || route.installationId !== installationId || !RETIRED.has(route.state)) {
      throw new Error("PDS deletion requires a retired installation");
    }
  }
}

/** What a deletion has left: the repository and, until the directory tombstones it, the DID. */
function receipt(input: InstallationDeletionRequest, status: RetirementStatus): InstallationDeletionReceipt {
  const { retirement } = status;
  const expiresAt = retirement?.phase === "erased" ? retirement.updatedAt + BACKUP_RETENTION_MS : null;
  const retained = expiresAt !== null && Date.now() < expiresAt;
  return {
    ...input,
    phase: retained ? "live-erased" : retirement?.phase ?? "pending",
    updatedAt: retirement?.updatedAt ?? Date.now(),
    pendingResources: (status.account ? 1 : 0) + (status.identity ? 1 : 0),
    outcome: retained ? "retention-pending" : retirement?.phase === "erased" ? "complete" : "progress",
    retainedCopies: retained ? [{ id: "pds-durable-object-backup", kind: "backup", expiresAt }] : [],
  };
}
