import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Packages",
    description: "Desktop package manager scaffold for browsing and installing packages.",
    icon: "ui/packages-icon.svg",
    window: {
      width: 920,
      height: 620,
      minWidth: 700,
      minHeight: 460,
    },
    capabilities: {
      kernel: [
        "pkg.list",
        "pkg.checkout",
        "pkg.install",
        "pkg.remove",
        "pkg.repo.refs",
        "pkg.repo.read",
        "pkg.repo.log",
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
          packageDoName: "package:packages",
          kernel: ctx.kernel,
          package: ctx.package,
        },
        env: {
          PACKAGE_ROUTE_BASE: routeBase,
        },
      });
    },
  },
});
