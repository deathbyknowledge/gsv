import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Processes",
    description: "Inspect and manage running agent processes.",
    window: {
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 520,
    },
    capabilities: {
      kernel: ["proc.list", "proc.kill"],
    },
  },
  app: {
    async fetch(request, ctx) {
      const routeBase = ctx.meta.routeBase ?? "/apps/processes";
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
