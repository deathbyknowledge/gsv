import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Control",
    description: "System configuration, access tokens, identity links, and MCP servers.",
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
        "sys.mcp.add",
        "sys.mcp.list",
        "sys.mcp.refresh",
        "sys.mcp.remove",
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
