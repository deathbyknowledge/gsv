import { definePackage } from "@gsv/package/worker";
import { killProcess, loadState } from "./backend/api";

export default definePackage({
  meta: {
    displayName: "Processes",
    description: "Inspect and manage running agent processes.",
    window: {
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 520,
    },
    capabilities: {
      kernel: ["proc.list", "proc.kill"],
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
      async killProcess(args, ctx) {
        return killProcess(ctx.kernel, args);
      },
    },
  },
});
