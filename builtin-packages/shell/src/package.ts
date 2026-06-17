import { definePackage } from "@humansandmachines/gsv/sdk/manifest";

export default definePackage({
  meta: {
    displayName: "Shell",
    description: "Interactive command shell for nodes.",
    icon: "icon.svg",
    window: {
      width: 1080,
      height: 760,
      minWidth: 360,
      minHeight: 320,
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
