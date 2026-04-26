import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Packages",
    description: "Trust, review, updates, source browsing, and lifecycle management for GSV packages.",
    icon: "ui/packages-icon.svg",
    window: {
      width: 1180,
      height: 800,
      minWidth: 920,
      minHeight: 620,
    },
    capabilities: {
      kernel: [
        "pkg.list",
        "pkg.add",
        "pkg.sync",
        "pkg.checkout",
        "pkg.install",
        "pkg.review.approve",
        "pkg.remove",
        "pkg.remote.list",
        "pkg.remote.add",
        "pkg.remote.remove",
        "pkg.public.list",
        "pkg.public.set",
        "proc.spawn",
        "repo.refs",
        "repo.read",
        "repo.search",
        "repo.log",
        "repo.diff",
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
