import { PackageBackendEntrypoint } from "@gsv/package/backend";
import { connectAccount, disconnectAccount, loadState } from "./backend/api";

export default class AdaptersBackend extends PackageBackendEntrypoint {
  async loadState(): Promise<unknown> {
    return loadState(this.kernel);
  }

  async connectAccount(args: unknown): Promise<unknown> {
    return connectAccount(this.kernel, args);
  }

  async disconnectAccount(args: unknown): Promise<unknown> {
    return disconnectAccount(this.kernel, args);
  }
}
