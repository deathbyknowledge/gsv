import { PackageBackendEntrypoint } from "@gsv/package/backend";
import { createFile, deletePath, loadState, saveFile } from "./backend/api";

export default class FilesBackend extends PackageBackendEntrypoint {
  async loadState(args: unknown): Promise<unknown> {
    return loadState(this.kernel, args as never);
  }

  async saveFile(args: unknown): Promise<unknown> {
    return saveFile(this.kernel, args as never);
  }

  async deletePath(args: unknown): Promise<unknown> {
    return deletePath(this.kernel, args as never);
  }

  async createFile(args: unknown): Promise<unknown> {
    return createFile(this.kernel, args as never);
  }
}
