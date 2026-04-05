import { definePackage } from "@gsv/package/worker";
import LegacyControlApp from "../ui/worker";

function createLegacyEntrypointContext(ctx: {
  meta: { packageId: string; routeBase: string | null };
  kernel: unknown;
  package: unknown;
}) {
  const routeBase = ctx.meta.routeBase ?? "/apps/control";
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
    displayName: "Control",
    description: "System status, permissions, and settings.",
    window: {
      width: 860,
      height: 580,
      minWidth: 640,
      minHeight: 420,
    },
    capabilities: {
      kernel: [
        "sys.config.get",
        "sys.config.set",
        "sys.token.create",
        "sys.token.list",
        "sys.token.revoke",
        "sys.link",
        "sys.unlink",
        "sys.link.list",
        "sys.link.consume",
        "adapter.connect",
        "adapter.disconnect",
        "adapter.status",
      ],
    },
  },
  app: {
    async fetch(request, ctx) {
      return LegacyControlApp.prototype.fetch.call(createLegacyEntrypointContext(ctx), request);
    },
  },
});
