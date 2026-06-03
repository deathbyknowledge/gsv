import { PackageBackendEntrypoint, type PackageSignalContext } from "@gsv/package/backend";
import {
  abortRun,
  compactConversation,
  decideHil,
  forkConversation,
  getHistory,
  getViewer,
  listConversations,
  listConversationSegments,
  listAgents,
  listProcesses,
  readProcessMedia,
  readConversationSegment,
  sendMessage,
  spawnProcess,
  unwatchProcessSignals,
  watchProcessSignals,
} from "./backend/api";

export default class ChatBackend extends PackageBackendEntrypoint {
  async listAgents(args: unknown): Promise<unknown> {
    return listAgents(this.kernel, args);
  }

  async listProcesses(args: unknown): Promise<unknown> {
    return listProcesses(this.kernel, args);
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

  async getViewer(): Promise<unknown> {
    return getViewer(this);
  }

  async readProcessMedia(args: unknown): Promise<unknown> {
    return readProcessMedia(this.kernel, args);
  }

  async listConversations(args: unknown): Promise<unknown> {
    return listConversations(this.kernel, args);
  }

  async compactConversation(args: unknown): Promise<unknown> {
    return compactConversation(this.kernel, args);
  }

  async listConversationSegments(args: unknown): Promise<unknown> {
    return listConversationSegments(this.kernel, args);
  }

  async readConversationSegment(args: unknown): Promise<unknown> {
    return readConversationSegment(this.kernel, args);
  }

  async forkConversation(args: unknown): Promise<unknown> {
    return forkConversation(this.kernel, args);
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
      return;
    }
    const state = ctx.watch.state && typeof ctx.watch.state === "object"
      ? ctx.watch.state as Record<string, unknown>
      : null;
    const clientId = typeof state?.clientId === "string" && state.clientId.trim().length > 0
      ? state.clientId.trim()
      : null;
    if (clientId) {
      await this.app.emitTo(clientId, ctx.signal, ctx.payload);
      return;
    }
    await this.app.emit(ctx.signal, ctx.payload);
  }
}
