import { definePackage } from "@humansandmachines/gsv/sdk/manifest";

export default definePackage({
  meta: {
    displayName: "Chat",
    description: "Conversational process interface for agents.",
    icon: "icon.svg",
    window: {
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 520,
    },
    capabilities: {
      kernel: [
        "proc.spawn",
        "proc.send",
        "proc.abort",
        "proc.hil",
        "proc.history",
        "proc.media.read",
        "proc.conversation.compact",
        "proc.conversation.fork",
        "proc.conversation.list",
        "proc.conversation.segment.read",
        "proc.conversation.segments",
        "account.list",
        "proc.list",
        "signal.watch",
        "signal.unwatch",
      ],
    },
  },
  browser: {
    entry: "./src/app/main.tsx",
    assets: [
      "./src/styles.css",
      "./src/styles/base.css",
      "./src/styles/navigation.css",
      "./src/styles/archive.css",
      "./src/styles/stage.css",
      "./src/styles/transcript.css",
      "./src/styles/media.css",
      "./src/styles/composer.css",
      "./src/styles/tools.css",
      "./src/styles/composer-controls.css",
      "./src/styles/modal.css",
      "./src/styles/responsive.css",
    ],
  },
  backend: {
    entry: "./src/backend.ts",
  },
});
