import { definePackage } from "@gsv/package/worker";
import {
  abortRun,
  decideHil,
  getHistory,
  getProcessState,
  getThreadSnapshot,
  listProfiles,
  listWorkspaces,
  sendMessage,
  spawnProcess,
} from "./backend/api";

export default definePackage({
  meta: {
    displayName: "Chat",
    description: "Conversational workspace with agents.",
    window: {
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 520,
    },
    capabilities: {
      kernel: ["proc.spawn", "proc.send", "proc.abort", "proc.hil", "proc.history", "proc.profile.list", "sys.workspace.list", "proc.list"],
    },
  },
  app: {
    browser: {
      entry: "./src/index.html",
    },
    assets: ["./src/styles.css"],
    rpc: {
      async listProfiles(args, ctx) {
        return listProfiles(ctx.kernel, args);
      },
      async listWorkspaces(args, ctx) {
        return listWorkspaces(ctx.kernel, args);
      },
      async spawnProcess(args, ctx) {
        return spawnProcess(ctx.kernel, args);
      },
      async sendMessage(args, ctx) {
        return sendMessage(ctx.kernel, args);
      },
      async getHistory(args, ctx) {
        return getHistory(ctx.kernel, args);
      },
      async abortRun(args, ctx) {
        return abortRun(ctx.kernel, args);
      },
      async decideHil(args, ctx) {
        return decideHil(ctx.kernel, args);
      },
      async getProcessState(args, ctx) {
        return getProcessState(ctx.kernel, args);
      },
      async getThreadSnapshot(args, ctx) {
        return getThreadSnapshot(ctx.kernel, args);
      },
    },
  },
});
