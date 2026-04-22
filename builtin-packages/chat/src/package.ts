import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Chat",
    description: "Conversational workspace with agents.",
    window: {
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 520,
    },
    capabilities: {
      kernel: ["proc.spawn", "proc.send", "proc.abort", "proc.hil", "proc.history", "proc.profile.list", "sys.workspace.list", "signal.watch", "signal.unwatch"],
    },
  },
  browser: {
    entry: "./src/app/main.js",
    assets: ["./src/styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
  },
});
