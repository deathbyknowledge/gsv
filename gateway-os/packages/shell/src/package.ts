import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

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
      const routeBase = ctx.meta.routeBase ?? "/apps/shell";
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
