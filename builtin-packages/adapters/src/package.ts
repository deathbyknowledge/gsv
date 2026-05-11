import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Adapters",
    description: "Manage connected accounts for WhatsApp, Discord, and future message adapters.",
    icon: "ui/adapters-icon.svg",
    window: {
      width: 1200,
      height: 760,
      minWidth: 320,
      minHeight: 480,
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
