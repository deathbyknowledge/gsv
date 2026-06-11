import { PackageBackendEntrypoint } from "@gsv/package/backend";
import { createFile, deletePath, listDevices, loadDirectory, loadFile, saveFile, searchFiles } from "./backend/api";

export default class FilesBackend extends PackageBackendEntrypoint {
  async listDevices(): Promise<unknown> {
    return listDevices(this.kernel);
  }

  async loadDirectory(args: unknown): Promise<unknown> {
    return loadDirectory(this.kernel, args as never, this);
  }

  async loadFile(args: unknown): Promise<unknown> {
    return loadFile(this.kernel, args as never);
  }

  async searchFiles(args: unknown): Promise<unknown> {
    return searchFiles(this.kernel, args as never);
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
