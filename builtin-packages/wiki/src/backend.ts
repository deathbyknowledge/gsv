import { PackageBackendEntrypoint, type PackageSignalContext } from "@humansandmachines/gsv/sdk/backend";
import {
  createDatabase,
  handleAppSignal,
  ingestSource,
  loadWorkspace,
  previewContent,
  savePage,
  startBuild,
} from "./backend/api";

export default class WikiBackend extends PackageBackendEntrypoint {
  async loadWorkspace(args: unknown): Promise<unknown> {
    return loadWorkspace(this.kernel, args as never, this.storage);
  }

  async previewContent(args: unknown): Promise<unknown> {
    return previewContent(this.kernel, args as never, this.storage);
  }

  async createDatabase(args: unknown): Promise<unknown> {
    return createDatabase(this.kernel, args as never, this.storage);
  }

  async savePage(args: unknown): Promise<unknown> {
    return savePage(this.kernel, args as never, this.storage);
  }

  async ingestSource(args: unknown): Promise<unknown> {
    return ingestSource(this.kernel, args as never, this.storage);
  }

  async startBuild(args: unknown): Promise<unknown> {
    return startBuild(this.kernel, args as never, this.storage);
  }

  override async onSignal(ctx: PackageSignalContext): Promise<void> {
    await handleAppSignal(ctx as never);
  }
}
