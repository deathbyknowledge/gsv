import { PackageBackendEntrypoint } from "@gsv/package/backend";
import {
  addRemote,
  approveReview,
  checkoutPackage,
  createPackage,
  diffRepo,
  disablePackage,
  enablePackage,
  importPackage,
  loadState,
  pullPackage,
  pullSource,
  readRepo,
  refreshPackage,
  refreshSource,
  removeRemote,
  searchRepo,
  setPublic,
  startReview,
  syncSources,
} from "./backend/api";

export default class PackagesBackend extends PackageBackendEntrypoint {
  async loadState(args: unknown): Promise<unknown> {
    return loadState(args as never, this.kernel, this);
  }

  async syncSources(): Promise<unknown> {
    return syncSources(this.kernel, this);
  }

  async importPackage(args: unknown): Promise<unknown> {
    return importPackage(this.kernel, args as never);
  }

  async createPackage(args: unknown): Promise<unknown> {
    return createPackage(this.kernel, args as never);
  }

  async addRemote(args: unknown): Promise<unknown> {
    return addRemote(this.kernel, args as never);
  }

  async removeRemote(args: unknown): Promise<unknown> {
    return removeRemote(this.kernel, args as never);
  }

  async enablePackage(args: unknown): Promise<unknown> {
    return enablePackage(this.kernel, args as never);
  }

  async disablePackage(args: unknown): Promise<unknown> {
    return disablePackage(this.kernel, args as never);
  }

  async approveReview(args: unknown): Promise<unknown> {
    return approveReview(this.kernel, args as never);
  }

  async refreshPackage(args: unknown): Promise<unknown> {
    return refreshPackage(this.kernel, args as never);
  }

  async refreshSource(args: unknown): Promise<unknown> {
    return refreshSource(this.kernel, args as never);
  }

  async pullPackage(args: unknown): Promise<unknown> {
    return pullPackage(this.kernel, args as never);
  }

  async pullSource(args: unknown): Promise<unknown> {
    return pullSource(this.kernel, args as never);
  }

  async checkoutPackage(args: unknown): Promise<unknown> {
    return checkoutPackage(this.kernel, args as never);
  }

  async setPublic(args: unknown): Promise<unknown> {
    return setPublic(this.kernel, args as never);
  }

  async startReview(args: unknown): Promise<unknown> {
    return startReview(this.kernel, args as never);
  }

  async readRepo(args: unknown): Promise<unknown> {
    return readRepo(this.kernel, args as never);
  }

  async searchRepo(args: unknown): Promise<unknown> {
    return searchRepo(this.kernel, args as never);
  }

  async diffRepo(args: unknown): Promise<unknown> {
    return diffRepo(this.kernel, args as never);
  }
}
