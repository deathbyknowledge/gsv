import { definePackage } from "@gsv/package/worker";

export default definePackage({
  meta: {
    displayName: "Chat",
    description: "Conversational workspace with agents.",
    window: {
      width: 880,
      height: 640,
      minWidth: 620,
      minHeight: 420,
    },
    capabilities: {
      kernel: ["proc.spawn", "proc.send", "proc.history", "sys.workspace.list"],
    },
  },
  app: {
    browser: {
      entry: "./index.html",
    },
  },
});
