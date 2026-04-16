import { definePackage } from "@gsv/package/worker";
import { execCommand, loadState } from "./backend/api";

export default definePackage({
  meta: {
    displayName: "Shell",
    description: "Interactive command shell for nodes.",
    window: {
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 520,
    },
    capabilities: {
      kernel: ["shell.exec", "sys.device.list"],
    },
  },
  app: {
    browser: {
      entry: "./src/index.html",
    },
    assets: ["./src/styles.css"],
    rpc: {
      async loadState(_args, ctx) {
        return loadState(ctx.kernel);
      },
      async execCommand(args, ctx) {
        return execCommand(ctx.kernel, args);
      },
    },
  },
});
