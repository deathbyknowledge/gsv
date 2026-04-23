import { definePackage } from "@gsv/package/manifest";

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
  browser: {
    entry: "./src/main.tsx",
    assets: ["./src/styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
  },
});
