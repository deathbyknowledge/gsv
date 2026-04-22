import { definePackage } from "@gsv/package/manifest";

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
  browser: {
    entry: "./src/main.tsx",
    assets: ["./src/styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
  },
});
