import { definePackage } from "@gsv/package/worker";
import { handleAppSignal, handleFetch, startBuildFromDirectory } from "../ui/worker";

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
    async fetch(request, ctx) {
      const routeBase = ctx.meta.routeBase ?? "/apps/wiki";
      return handleFetch(request, {
        props: {
          appFrame: { packageId: ctx.meta.packageId, routeBase },
          kernel: ctx.kernel,
        },
        env: { PACKAGE_ROUTE_BASE: routeBase },
      });
    },
    rpc: {
      startBuildFromDirectory: async (args, ctx) => startBuildFromDirectory(ctx.kernel, args),
    },
    async onSignal(ctx) {
      await handleAppSignal(ctx);
    },
  },
});
