import { PackageBackendEntrypoint, type PackageSignalContext } from "@gsv/package/backend";
import {
  abortRun,
  decideHil,
  getHistory,
  listProfiles,
  listWorkspaces,
  sendMessage,
  spawnProcess,
  unwatchProcessSignals,
  watchProcessSignals,
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

  async watchProcessSignals(args: unknown): Promise<unknown> {
    return watchProcessSignals(this.kernel, this.app, args);
  }

  async unwatchProcessSignals(args: unknown): Promise<unknown> {
    return unwatchProcessSignals(this.kernel, this.app, args);
  }

  override async onSignal(ctx: PackageSignalContext): Promise<void> {
    if (!this.app) {
      console.log(`[chat-backend] onSignal signal=${ctx.signal} no app binding`);
      return;
    }
    const state = ctx.watch.state && typeof ctx.watch.state === "object"
      ? ctx.watch.state as Record<string, unknown>
      : null;
    const clientId = typeof state?.clientId === "string" && state.clientId.trim().length > 0
      ? state.clientId.trim()
      : null;
    console.log(`[chat-backend] onSignal signal=${ctx.signal} clientId=${clientId ?? "*"} watchKey=${ctx.watch.key ?? ""}`);
    if (clientId) {
      const result = await this.app.emitTo(clientId, ctx.signal, ctx.payload);
      console.log(`[chat-backend] onSignal emitTo delivered=${result.delivered} signal=${ctx.signal} clientId=${clientId}`);
      return;
    }
    const result = await this.app.emit(ctx.signal, ctx.payload);
    console.log(`[chat-backend] onSignal emit delivered=${result.delivered} signal=${ctx.signal}`);
  }
}
