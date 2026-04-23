import { PackageBackendEntrypoint } from "@gsv/package/backend";
import { execCommand, loadState } from "./backend/api";

export default class ShellBackend extends PackageBackendEntrypoint {
  async loadState(args: Record<string, never> = {}): Promise<unknown> {
    void args;
    return loadState(this.kernel);
  }

  async execCommand(args: unknown): Promise<unknown> {
    return execCommand(this.kernel, args);
  }
}
