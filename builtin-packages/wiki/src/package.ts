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
        "knowledge.db.list",
        "knowledge.db.init",
        "knowledge.list",
        "knowledge.read",
        "knowledge.write",
        "knowledge.search",
        "knowledge.query",
        "knowledge.ingest",
        "knowledge.compile",
        "knowledge.merge",
        "notification.create",
        "proc.spawn",
        "proc.send",
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
});
