import { definePackage } from "@gsv/package/worker";
import LegacyShellApp from "../ui/worker";

function createLegacyEntrypointContext(ctx: {
  meta: { packageId: string; routeBase: string | null };
  kernel: unknown;
  package: unknown;
}) {
  const routeBase = ctx.meta.routeBase ?? "/apps/shell";
  return {
    ctx: {
      props: {
        appFrame: {
          packageId: ctx.meta.packageId,
          routeBase,
        },
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
    displayName: "Shell",
    description: "Interactive command shell for nodes.",
    window: {
      width: 980,
      height: 640,
      minWidth: 700,
      minHeight: 420,
    },
    capabilities: {
      kernel: ["shell.exec", "sys.device.list"],
    },
  },
  app: {
    async fetch(request, ctx) {
      return LegacyShellApp.prototype.fetch.call(createLegacyEntrypointContext(ctx), request);
    },
  },
});
