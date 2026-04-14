import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Packages",
    description: "Desktop package manager scaffold for browsing and installing packages.",
    icon: "ui/packages-icon.svg",
    window: {
      width: 1120,
      height: 780,
      minWidth: 820,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "pkg.list",
        "pkg.add",
        "pkg.checkout",
        "pkg.install",
        "pkg.review.approve",
        "pkg.remove",
        "pkg.repo.refs",
        "pkg.repo.read",
        "pkg.repo.log",
        "pkg.repo.search",
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
    async fetch(request, ctx) {
      const routeBase = ctx.meta.routeBase ?? "/apps/packages";
      return handleFetch(request, {
        props: {
          appFrame: {
            packageId: ctx.meta.packageId,
            routeBase,
          },
          kernel: ctx.kernel,
        },
        env: {
          PACKAGE_ROUTE_BASE: routeBase,
        },
      });
    },
  },
});
