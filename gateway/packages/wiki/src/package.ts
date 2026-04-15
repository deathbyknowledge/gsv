import { definePackage } from "@gsv/package/worker";
import {
  compileInboxNote,
  createDatabase,
  getPreview,
  handleAppSignal,
  ingestSourcesToInbox,
  loadState,
  startBuildFromDirectory,
  writePage,
} from "../ui/backend";

export default definePackage({
  meta: {
    displayName: "Wiki",
    description: "Knowledge databases, pages, and inbox review.",
    window: {
      width: 1180,
      height: 800,
      minWidth: 860,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "fs.read",
        "knowledge.db.list",
        "knowledge.db.init",
        "knowledge.list",
        "knowledge.read",
        "knowledge.write",
        "knowledge.search",
        "knowledge.query",
        "knowledge.ingest",
        "knowledge.compile",
        "knowledge.merge",
        "notification.create",
        "proc.spawn",
        "proc.send",
        "signal.watch",
        "signal.unwatch",
      ],
    },
  },
  app: {
    browser: {
      entry: "./index.html",
    },
    assets: ["./styles.css"],
    rpc: {
      loadState: async (args, ctx) => loadState(ctx.kernel, args),
      preview: async (args, ctx) => getPreview(ctx.kernel, args),
      createDatabase: async (args, ctx) => createDatabase(ctx.kernel, args),
      writePage: async (args, ctx) => writePage(ctx.kernel, args),
      ingestSourcesToInbox: async (args, ctx) => ingestSourcesToInbox(ctx.kernel, args),
      compileInboxNote: async (args, ctx) => compileInboxNote(ctx.kernel, args),
      startBuildFromDirectory: async (args, ctx) => startBuildFromDirectory(ctx.kernel, args),
    },
    async onSignal(ctx) {
      await handleAppSignal(ctx);
    },
  },
});
