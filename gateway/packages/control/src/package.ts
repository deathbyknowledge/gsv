import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Control",
    description: "System status, permissions, and settings.",
    window: {
      width: 1040,
      height: 720,
      minWidth: 760,
      minHeight: 520,
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
      const routeBase = ctx.meta.routeBase ?? "/apps/control";
      return handleFetch(request, {
        props: {
          appFrame: { packageId: ctx.meta.packageId, routeBase },
          kernel: ctx.kernel,
          package: ctx.package,
        },
        env: { PACKAGE_ROUTE_BASE: routeBase },
      });
    },
  },
});
