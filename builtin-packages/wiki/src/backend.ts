import { PackageBackendEntrypoint, type PackageSignalContext } from "@gsv/package/backend";
import {
  compileInboxNote,
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
    return loadWorkspace(this.kernel, args as never);
  }

  async previewContent(args: unknown): Promise<unknown> {
    return previewContent(this.kernel, args as never);
  }

  async createDatabase(args: unknown): Promise<unknown> {
    return createDatabase(this.kernel, args as never);
  }

  async savePage(args: unknown): Promise<unknown> {
    return savePage(this.kernel, args as never);
  }

  async ingestSource(args: unknown): Promise<unknown> {
    return ingestSource(this.kernel, args as never);
  }

  async compileInboxNote(args: unknown): Promise<unknown> {
    return compileInboxNote(this.kernel, args as never);
  }

  async startBuild(args: unknown): Promise<unknown> {
    return startBuild(this.kernel, args as never);
  }

  override async onSignal(ctx: PackageSignalContext): Promise<void> {
    await handleAppSignal(ctx as never);
  }
}
