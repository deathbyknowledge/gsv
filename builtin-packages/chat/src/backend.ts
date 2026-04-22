import { PackageBackendEntrypoint } from "@gsv/package/backend";
import {
  abortRun,
  decideHil,
  getHistory,
  listProfiles,
  listWorkspaces,
  sendMessage,
  spawnProcess,
} from "./backend/api";

export default class ChatBackend extends PackageBackendEntrypoint {
  async listProfiles(args: unknown): Promise<unknown> {
    return listProfiles(this.kernel, args);
  }

  async listWorkspaces(args: unknown): Promise<unknown> {
    return listWorkspaces(this.kernel, args);
  }

  async spawnProcess(args: unknown): Promise<unknown> {
    return spawnProcess(this.kernel, args);
  }

  async sendMessage(args: unknown): Promise<unknown> {
    return sendMessage(this.kernel, args);
  }

  async getHistory(args: unknown): Promise<unknown> {
    return getHistory(this.kernel, args);
  }

  async abortRun(args: unknown): Promise<unknown> {
    return abortRun(this.kernel, args);
  }

  async decideHil(args: unknown): Promise<unknown> {
    return decideHil(this.kernel, args);
  }
}
