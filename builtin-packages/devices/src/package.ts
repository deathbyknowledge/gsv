import { definePackage } from "@gsv/package/manifest";

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
  browser: {
    entry: "./src/main.tsx",
    assets: ["./src/styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
  },
});
