import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { AdapterInstallationRetirement, type AdapterInstallationRegistration, type AdapterInstallationResource } from "../../shared/src/installation-retirement";
import { runAdapterInstallationSqlMigrations } from "../../shared/src/schema/installation-migrations";
import { AdapterLifecycle } from "../../shared/src/lifecycle";
import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import type { InstallationDeletionInspection, InstallationDeletionInventoryImport } from "../../../../packages/gsv/src/services/lifecycle-discovery.js";
import type { ManagedTelegramPeerEnv } from "./managed-peer";

export class TelegramInstallation extends DurableObject<ManagedTelegramPeerEnv> {
  private readonly owner: AdapterInstallationRetirement;
  constructor(ctx: DurableObjectState, env: ManagedTelegramPeerEnv) {
    super(ctx, env);
    if (!ctx.id.name) throw new Error("Telegram installation identity is unavailable");
    runAdapterInstallationSqlMigrations(ctx.storage);
    this.owner = new AdapterInstallationRetirement(ctx.storage, ctx.id.name, {
      self: { kind: "adapter-installation", name: ctx.id.name, objectId: ctx.id.toString() },
      resolve: (resource) => resolveResource(env, resource),
    });
  }
  async registeredResource(kind: AdapterInstallationResource["kind"], objectId: string) { return this.owner.registeredResource(kind, objectId); }
  async registerResource(resource: AdapterInstallationRegistration) { this.owner.registerResource(resource); }
  async importInstallationDeletionInventory(input: InstallationDeletionInventoryImport) { return await this.owner.importInstallationDeletionInventory(input); }
  async quiesceInstallation(input: InstallationDeletionRequest) { return await this.owner.quiesceInstallation(input); }
  async eraseInstallation(input: InstallationDeletionRequest) { return await this.owner.eraseInstallation(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return await this.owner.installationDeletionStatus(input); }
  async inspectInstallationResource(_installationId: string) { return { name: this.ctx.id.name!, outcome: "identified" as const, installationId: this.ctx.id.name! }; }
}

export class TelegramLifecycleEntrypoint extends WorkerEntrypoint<ManagedTelegramPeerEnv, { authority?: string }> {
  private service() {
    return new AdapterLifecycle({ authority: this.ctx.props?.authority, directory: this.env.ACCOUNTS,
      coordinator: (id) => this.env.TELEGRAM_INSTALLATIONS.getByName(id),
      coordinatorId: (id) => this.env.TELEGRAM_INSTALLATIONS.idFromName(id).toString(),
      namespace: (kind) => kind === "adapter-peer" ? this.env.MANAGED_TELEGRAM_PEER : kind === "adapter-pairing" ? this.env.MANAGED_TELEGRAM_PAIRING : null,
    });
  }
  async inspectInstallationDeletion(input: InstallationDeletionInspection) { return await this.service().inspectInstallationDeletion(input); }
  async importInstallationDeletionInventory(input: InstallationDeletionInventoryImport) { return await this.service().importInstallationDeletionInventory(input); }
  async quiesceInstallation(input: InstallationDeletionRequest) { return await this.service().quiesceInstallation(input); }
  async eraseInstallation(input: InstallationDeletionRequest) { return await this.service().eraseInstallation(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return await this.service().installationDeletionStatus(input); }
}

function resolveResource(env: ManagedTelegramPeerEnv, resource: AdapterInstallationResource) {
  const namespace = resource.kind === "adapter-peer" ? env.MANAGED_TELEGRAM_PEER : resource.kind === "adapter-pairing" ? env.MANAGED_TELEGRAM_PAIRING : null;
  if (!namespace) return null;
  if (namespace.idFromName(resource.name).toString() !== resource.objectId) throw new Error("Telegram resource identity mismatch");
  return namespace.get(namespace.idFromName(resource.name));
}
