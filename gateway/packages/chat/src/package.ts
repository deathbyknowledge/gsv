import { definePackage } from "@gsv/package/worker";

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
      kernel: ["proc.spawn", "proc.send", "proc.abort", "proc.hil", "proc.history", "sys.workspace.list"],
    },
  },
  app: {
    browser: {
      entry: "./index.html",
    },
  },
});
