import { PackageBackendEntrypoint } from "@gsv/package/backend";
import {
  createAgent,
  createHuman,
  loadAgentContext,
  loadAgentsState,
  saveAgentContext,
  setAgentBehavior,
} from "./backend/agents";
import { connectAdapter, disconnectAdapter, loadAdaptersState } from "./backend/adapters";
import {
  applyConfigEntries,
  consumeIdentityLinkCode,
  createAccessToken,
  createIdentityLink,
  loadAdministrationState,
  removeIdentityLink,
  revokeAccessToken,
} from "./backend/control";
import {
  createDeviceNodeToken,
  loadDevicesState,
  revokeDeviceToken,
  updateDeviceDescription,
} from "./backend/devices";
import { addMcpServer, loadMcpState, refreshMcpServer, removeMcpServer } from "./backend/mcp";
import {
  approvePackageReview,
  addCatalogRemote,
  createPackage,
  disablePackage,
  enablePackage,
  importPackage,
  loadPackagesState,
  pullPackage,
  pullPackageSource,
  refreshPackage,
  removeCatalogRemote,
  setPackagePublic,
  startPackageReview,
  syncPackages,
} from "./backend/packages";
import { killRuntimeProcess, loadRuntimeState } from "./backend/runtime";
import {
  createSourceRepo,
  diffSourceRepo,
  loadSourceCommits,
  loadSourcesState,
  pullSourceRepo,
  searchSourceRepo,
  setSourceRepoPublic,
} from "./backend/sources";

export default class GsvBackend extends PackageBackendEntrypoint {
  async loadAdministrationState(args: Record<string, never> = {}): Promise<unknown> {
    void args;
    return loadAdministrationState(this.kernel, this);
  }

  async applyConfigEntries(args: unknown): Promise<unknown> {
    return applyConfigEntries(this.kernel, this, args as never);
  }

  async createAccessToken(args: unknown): Promise<unknown> {
    return createAccessToken(this.kernel, this, args as never);
  }

  async revokeAccessToken(args: unknown): Promise<unknown> {
    return revokeAccessToken(this.kernel, this, args as never);
  }

  async consumeIdentityLinkCode(args: unknown): Promise<unknown> {
    return consumeIdentityLinkCode(this.kernel, this, args as never);
  }

  async createIdentityLink(args: unknown): Promise<unknown> {
    return createIdentityLink(this.kernel, this, args as never);
  }

  async removeIdentityLink(args: unknown): Promise<unknown> {
    return removeIdentityLink(this.kernel, this, args as never);
  }

  async loadRuntimeState(): Promise<unknown> {
    return loadRuntimeState(this.kernel);
  }

  async killRuntimeProcess(args: unknown): Promise<unknown> {
    return killRuntimeProcess(this.kernel, args as never);
  }

  async loadDevicesState(args: unknown): Promise<unknown> {
    return loadDevicesState(this.kernel, this, args as never);
  }

  async createDeviceNodeToken(args: unknown): Promise<unknown> {
    return createDeviceNodeToken(this.kernel, this, args as never);
  }

  async revokeDeviceToken(args: unknown): Promise<unknown> {
    return revokeDeviceToken(this.kernel, this, args as never);
  }

  async updateDeviceDescription(args: unknown): Promise<unknown> {
    return updateDeviceDescription(this.kernel, this, args as never);
  }

  async loadAdaptersState(): Promise<unknown> {
    return loadAdaptersState(this.kernel);
  }

  async connectAdapter(args: unknown): Promise<unknown> {
    return connectAdapter(this.kernel, args as never);
  }

  async disconnectAdapter(args: unknown): Promise<unknown> {
    return disconnectAdapter(this.kernel, args as never);
  }

  async loadMcpState(): Promise<unknown> {
    return loadMcpState(this.kernel);
  }

  async addMcpServer(args: unknown): Promise<unknown> {
    return addMcpServer(this.kernel, args as never);
  }

  async refreshMcpServer(args: unknown): Promise<unknown> {
    return refreshMcpServer(this.kernel, args as never);
  }

  async removeMcpServer(args: unknown): Promise<unknown> {
    return removeMcpServer(this.kernel, args as never);
  }

  async loadPackagesState(args: unknown): Promise<unknown> {
    return loadPackagesState(args as never, this.kernel, this);
  }

  async syncPackages(): Promise<unknown> {
    return syncPackages(this.kernel, this);
  }

  async importPackage(args: unknown): Promise<unknown> {
    return importPackage(this.kernel, args as never);
  }

  async createPackage(args: unknown): Promise<unknown> {
    return createPackage(this.kernel, args as never);
  }

  async addCatalogRemote(args: unknown): Promise<unknown> {
    return addCatalogRemote(this.kernel, args as never);
  }

  async removeCatalogRemote(args: unknown): Promise<unknown> {
    return removeCatalogRemote(this.kernel, args as never);
  }

  async enablePackage(args: unknown): Promise<unknown> {
    return enablePackage(this.kernel, args as never);
  }

  async disablePackage(args: unknown): Promise<unknown> {
    return disablePackage(this.kernel, args as never);
  }

  async approvePackageReview(args: unknown): Promise<unknown> {
    return approvePackageReview(this.kernel, args as never);
  }

  async refreshPackage(args: unknown): Promise<unknown> {
    return refreshPackage(this.kernel, args as never);
  }

  async pullPackage(args: unknown): Promise<unknown> {
    return pullPackage(this.kernel, args as never);
  }

  async pullPackageSource(args: unknown): Promise<unknown> {
    return pullPackageSource(this.kernel, args as never);
  }

  async setPackagePublic(args: unknown): Promise<unknown> {
    return setPackagePublic(this.kernel, args as never);
  }

  async startPackageReview(args: unknown): Promise<unknown> {
    return startPackageReview(this.kernel, args as never);
  }

  async loadSourcesState(args: unknown): Promise<unknown> {
    return loadSourcesState(args as never, this.kernel);
  }

  async loadSourceCommits(args: unknown): Promise<unknown> {
    return loadSourceCommits(this.kernel, args as never);
  }

  async searchSourceRepo(args: unknown): Promise<unknown> {
    return searchSourceRepo(this.kernel, args as never);
  }

  async diffSourceRepo(args: unknown): Promise<unknown> {
    return diffSourceRepo(this.kernel, args as never);
  }

  async pullSourceRepo(args: unknown): Promise<unknown> {
    return pullSourceRepo(this.kernel, args as never);
  }

  async setSourceRepoPublic(args: unknown): Promise<unknown> {
    return setSourceRepoPublic(this.kernel, args as never);
  }

  async createSourceRepo(args: unknown): Promise<unknown> {
    return createSourceRepo(this.kernel, args as never);
  }

  async loadAgentsState(args: Record<string, never> = {}): Promise<unknown> {
    void args;
    return loadAgentsState(this.kernel, this);
  }

  async loadAgentContext(args: unknown): Promise<unknown> {
    return loadAgentContext(this.kernel, args as never);
  }

  async saveAgentContext(args: unknown): Promise<unknown> {
    return saveAgentContext(this.kernel, args as never);
  }

  async setAgentBehavior(args: unknown): Promise<unknown> {
    return setAgentBehavior(this.kernel, args as never);
  }

  async createAgent(args: unknown): Promise<unknown> {
    return createAgent(this.kernel, args as never);
  }

  async createHuman(args: unknown): Promise<unknown> {
    return createHuman(this.kernel, args as never);
  }
}
