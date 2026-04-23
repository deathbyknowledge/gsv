import { PackageBackendEntrypoint } from "@gsv/package/backend";
import {
  applyRawConfig,
  consumeLinkCode,
  createLink,
  createToken,
  loadState,
  revokeToken,
  saveEntry,
  unlink,
} from "./backend/api";

export default class ControlBackend extends PackageBackendEntrypoint {
  async loadState(args: Record<string, never> = {}): Promise<unknown> {
    void args;
    return loadState(this.kernel, this);
  }

  async saveEntry(args: unknown): Promise<unknown> {
    return saveEntry(this.kernel, this, args as never);
  }

  async createToken(args: unknown): Promise<unknown> {
    return createToken(this.kernel, this, args as never);
  }

  async revokeToken(args: unknown): Promise<unknown> {
    return revokeToken(this.kernel, this, args as never);
  }

  async consumeLinkCode(args: unknown): Promise<unknown> {
    return consumeLinkCode(this.kernel, this, args as never);
  }

  async createLink(args: unknown): Promise<unknown> {
    return createLink(this.kernel, this, args as never);
  }

  async unlink(args: unknown): Promise<unknown> {
    return unlink(this.kernel, this, args as never);
  }

  async applyRawConfig(args: unknown): Promise<unknown> {
    return applyRawConfig(this.kernel, this, args as never);
  }
}
