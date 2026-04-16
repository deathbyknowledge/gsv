import { definePackage } from "@gsv/package/worker";
import {
  addRemote,
  approveReview,
  checkoutPackage,
  diffRepo,
  disablePackage,
  enablePackage,
  importPackage,
  loadState,
  readRepo,
  refreshPackage,
  refreshSource,
  removeRemote,
  searchRepo,
  setPublic,
  startReview,
  syncSources,
} from "./backend/api";

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
  app: {
    browser: {
      entry: "./src/index.html",
    },
    assets: ["./src/styles.css"],
    rpc: {
      async loadState(args, ctx) {
        return loadState(args, ctx.kernel, ctx);
      },
      async syncSources(_args, ctx) {
        return syncSources(ctx.kernel);
      },
      async importPackage(args, ctx) {
        return importPackage(ctx.kernel, args);
      },
      async addRemote(args, ctx) {
        return addRemote(ctx.kernel, args);
      },
      async removeRemote(args, ctx) {
        return removeRemote(ctx.kernel, args);
      },
      async enablePackage(args, ctx) {
        return enablePackage(ctx.kernel, args);
      },
      async disablePackage(args, ctx) {
        return disablePackage(ctx.kernel, args);
      },
      async approveReview(args, ctx) {
        return approveReview(ctx.kernel, args);
      },
      async refreshPackage(args, ctx) {
        return refreshPackage(ctx.kernel, args);
      },
      async refreshSource(args, ctx) {
        return refreshSource(ctx.kernel, args);
      },
      async checkoutPackage(args, ctx) {
        return checkoutPackage(ctx.kernel, args);
      },
      async setPublic(args, ctx) {
        return setPublic(ctx.kernel, args);
      },
      async startReview(args, ctx) {
        return startReview(ctx.kernel, args);
      },
      async readRepo(args, ctx) {
        return readRepo(ctx.kernel, args);
      },
      async searchRepo(args, ctx) {
        return searchRepo(ctx.kernel, args);
      },
      async diffRepo(args, ctx) {
        return diffRepo(ctx.kernel, args);
      },
    },
  },
});
