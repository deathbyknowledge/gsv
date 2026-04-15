import { definePackage } from "@gsv/package/worker";
import { createFile, deletePath, loadState, saveFile } from "./backend/api";

export default definePackage({
  meta: {
    displayName: "Files",
    description: "File browser and workspace management.",
    window: {
      width: 1080,
      height: 760,
      minWidth: 780,
      minHeight: 520,
    },
    capabilities: {
      kernel: ["fs.read", "fs.search", "fs.write", "fs.edit", "fs.delete", "sys.device.list"],
    },
  },
  app: {
    browser: {
      entry: "./src/index.html",
    },
    assets: ["./src/styles.css"],
    rpc: {
      async loadState(args, ctx) {
        return loadState(ctx.kernel, args);
      },
      async saveFile(args, ctx) {
        return saveFile(ctx.kernel, args);
      },
      async deletePath(args, ctx) {
        return deletePath(ctx.kernel, args);
      },
      async createFile(args, ctx) {
        return createFile(ctx.kernel, args);
      },
    },
  },
});
