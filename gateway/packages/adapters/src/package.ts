import { definePackage } from "@gsv/package/worker";
import { connectAccount, disconnectAccount, loadState } from "./backend/api";

export default definePackage({
  meta: {
    displayName: "Adapters",
    description: "Manage connected accounts for WhatsApp, Discord, and future message adapters.",
    window: {
      width: 1120,
      height: 760,
      minWidth: 860,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "adapter.connect",
        "adapter.disconnect",
        "adapter.status",
      ],
    },
  },
  app: {
    browser: {
      entry: "./index.html",
    },
    assets: ["./styles.css"],
    rpc: {
      loadState: async (_args, ctx) => loadState(ctx.kernel),
      connectAccount: async (args, ctx) => connectAccount(ctx.kernel, args),
      disconnectAccount: async (args, ctx) => disconnectAccount(ctx.kernel, args),
    },
  },
});
