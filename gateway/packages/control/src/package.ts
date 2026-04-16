import { definePackage } from "@gsv/package/worker";
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

export default definePackage({
  meta: {
    displayName: "Control",
    description: "System configuration, access tokens, and identity links.",
    window: {
      width: 1120,
      height: 820,
      minWidth: 860,
      minHeight: 620,
    },
    capabilities: {
      kernel: [
        "sys.config.get",
        "sys.config.set",
        "sys.token.create",
        "sys.token.list",
        "sys.token.revoke",
        "sys.link",
        "sys.unlink",
        "sys.link.list",
        "sys.link.consume",
      ],
    },
  },
  app: {
    browser: {
      entry: "./src/index.html",
    },
    assets: ["./src/styles.css"],
    rpc: {
      async loadState(_args, ctx) {
        return loadState(ctx.kernel, ctx);
      },
      async saveEntry(args, ctx) {
        return saveEntry(ctx.kernel, ctx, args);
      },
      async createToken(args, ctx) {
        return createToken(ctx.kernel, ctx, args);
      },
      async revokeToken(args, ctx) {
        return revokeToken(ctx.kernel, ctx, args);
      },
      async consumeLinkCode(args, ctx) {
        return consumeLinkCode(ctx.kernel, ctx, args);
      },
      async createLink(args, ctx) {
        return createLink(ctx.kernel, ctx, args);
      },
      async unlink(args, ctx) {
        return unlink(ctx.kernel, ctx, args);
      },
      async applyRawConfig(args, ctx) {
        return applyRawConfig(ctx.kernel, ctx, args);
      },
    },
  },
});
