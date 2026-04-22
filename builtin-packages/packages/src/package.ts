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
        "pkg.repo.refs",
        "pkg.repo.read",
        "pkg.repo.search",
        "pkg.repo.log",
        "pkg.repo.diff",
        "pkg.remote.list",
        "pkg.remote.add",
        "pkg.remote.remove",
        "pkg.public.list",
        "pkg.public.set",
        "proc.spawn",
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
