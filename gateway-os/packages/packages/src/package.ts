import { definePackage } from "@gsv/package/worker";
import LegacyPackagesApp from "../ui/worker";

function createLegacyEntrypointContext(ctx: {
  meta: { packageId: string; routeBase: string | null };
  kernel: unknown;
  package: unknown;
}) {
  const routeBase = ctx.meta.routeBase ?? "/apps/packages";
  return {
    ctx: {
      props: {
        appFrame: {
          packageId: ctx.meta.packageId,
          routeBase,
        },
        packageDoName: "package:packages",
        kernel: ctx.kernel,
        package: ctx.package,
      },
    },
    env: {
      PACKAGE_ROUTE_BASE: routeBase,
    },
  };
}

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
      return LegacyPackagesApp.prototype.fetch.call(createLegacyEntrypointContext(ctx), request);
    },
  },
});
