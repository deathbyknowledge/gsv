import { definePackage } from "@gsv/package/worker";
import {
  createNodeToken,
  loadState,
  revokeToken,
} from "./backend/api";

export default definePackage({
  meta: {
    displayName: "Devices",
    description: "Execution targets, node health, and fleet enrollment.",
    window: {
      width: 1180,
      height: 760,
      minWidth: 920,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "sys.device.list",
        "sys.device.get",
        "sys.token.create",
        "sys.token.list",
        "sys.token.revoke",
      ],
    },
  },
  app: {
    browser: {
      entry: "./src/index.html",
    },
    assets: ["./src/styles.css"],
    rpc: {
      async loadState(args, ctx) {
        return loadState(args, ctx.kernel, ctx);
      },
      async createNodeToken(args, ctx) {
        return createNodeToken(args, ctx.kernel, ctx);
      },
      async revokeToken(args, ctx) {
        return revokeToken(args, ctx.kernel, ctx);
      },
    },
  },
});
