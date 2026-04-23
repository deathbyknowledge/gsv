import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Control",
    description: "System configuration, access tokens, and identity links.",
    window: {
      width: 1120,
      height: 820,
      minWidth: 860,
      minHeight: 620,
    },
    capabilities: {
      kernel: [
        "sys.config.get",
        "sys.config.set",
        "sys.token.create",
        "sys.token.list",
        "sys.token.revoke",
        "sys.link",
        "sys.unlink",
        "sys.link.list",
        "sys.link.consume",
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
