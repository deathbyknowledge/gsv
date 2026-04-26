import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Wiki",
    description: "Knowledge databases, pages, inbox review, and guided wiki-building workflows.",
    icon: "ui/wiki-icon.svg",
    window: {
      width: 1220,
      height: 820,
      minWidth: 920,
      minHeight: 620,
    },
    capabilities: {
      kernel: [
        "fs.read",
        "notification.create",
        "proc.spawn",
        "proc.send",
        "repo.apply",
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
