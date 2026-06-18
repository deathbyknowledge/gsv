import { definePackage } from "@humansandmachines/gsv/sdk/manifest";

export default definePackage({
  meta: {
    displayName: "Wiki",
    description: "Git-backed wiki collections, pages, inbox review, and guided wiki-building workflows.",
    icon: "icon.svg",
    window: {
      width: 1220,
      height: 820,
      minWidth: 360,
      minHeight: 480,
    },
    capabilities: {
      kernel: [
        "fs.read",
        "notification.create",
        "proc.spawn",
        "proc.send",
        "repo.apply",
        "repo.create",
        "repo.list",
        "repo.read",
        "signal.watch",
        "signal.unwatch",
      ],
    },
  },
  browser: {
    entry: "./main.tsx",
    assets: ["./styles.css"],
  },
  backend: {
    entry: "./src/backend.ts",
  },
  cli: {
    commands: {
      wiki: "./src/cli/wiki.ts",
    },
  },
});
