import { definePackage } from "@gsv/package/manifest";

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
  browser: {
    entry: "./src/main.tsx",
    assets: ["./src/styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
  },
});
