import { PackageBackendEntrypoint } from "@gsv/package/backend";
import { createNodeToken, loadState, revokeToken, updateDeviceDescription } from "./backend/api";

export default class DevicesBackend extends PackageBackendEntrypoint {
  async loadState(args: unknown): Promise<unknown> {
    return loadState(args as never, this.kernel, this);
  }

  async createNodeToken(args: unknown): Promise<unknown> {
    return createNodeToken(args as never, this.kernel, this);
  }

  async revokeToken(args: unknown): Promise<unknown> {
    return revokeToken(args as never, this.kernel, this);
  }

  async updateDeviceDescription(args: unknown): Promise<unknown> {
    return updateDeviceDescription(args as never, this.kernel, this);
  }
}
