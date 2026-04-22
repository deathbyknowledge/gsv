import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Adapters",
    description: "Manage connected accounts for WhatsApp, Discord, and future message adapters.",
    icon: "ui/adapters-icon.svg",
    window: {
      width: 1120,
      height: 760,
      minWidth: 860,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "adapter.connect",
        "adapter.disconnect",
        "adapter.status",
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
