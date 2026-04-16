import { definePackage } from "@gsv/package/worker";
import {
  compileInboxNote,
  createDatabase,
  handleAppSignal,
  ingestSource,
  loadWorkspace,
  previewContent,
  savePage,
  startBuild,
} from "./backend/api";

export default definePackage({
  meta: {
    displayName: "Wiki",
    description: "Knowledge databases, pages, inbox review, and guided wiki-building workflows.",
    icon: "ui/wiki-icon.svg",
    window: {
      width: 1220,
      height: 820,
      minWidth: 920,
      minHeight: 620,
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
      loadWorkspace: async (args, ctx) => loadWorkspace(ctx.kernel, args),
      previewContent: async (args, ctx) => previewContent(ctx.kernel, args),
      createDatabase: async (args, ctx) => createDatabase(ctx.kernel, args),
      savePage: async (args, ctx) => savePage(ctx.kernel, args),
      ingestSource: async (args, ctx) => ingestSource(ctx.kernel, args),
      compileInboxNote: async (args, ctx) => compileInboxNote(ctx.kernel, args),
      startBuild: async (args, ctx) => startBuild(ctx.kernel, args),
    },
    async onSignal(ctx) {
      await handleAppSignal(ctx);
    },
  },
});
