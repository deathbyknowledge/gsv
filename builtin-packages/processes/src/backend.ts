import { PackageBackendEntrypoint } from "@gsv/package/backend";
import { killProcess, loadState } from "./backend/api";

export default class ProcessesBackend extends PackageBackendEntrypoint {
  async loadState(): Promise<unknown> {
    return loadState(this.kernel);
  }

  async killProcess(args: unknown): Promise<unknown> {
    return killProcess(this.kernel, args as never);
  }
}
