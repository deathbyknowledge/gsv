import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Adapters",
    description: "Connect WhatsApp, Discord, and future message adapters without raw kernel forms.",
    window: {
      width: 980,
      height: 700,
      minWidth: 760,
      minHeight: 520,
    },
    capabilities: {
      kernel: [
        "adapter.connect",
        "adapter.disconnect",
        "adapter.status",
      ],
    },
  },
  app: {
    async fetch(request, ctx) {
      const routeBase = ctx.meta.routeBase ?? "/apps/adapters";
      return handleFetch(request, {
        props: {
          appFrame: { packageId: ctx.meta.packageId, routeBase },
          kernel: ctx.kernel,
        },
        env: { PACKAGE_ROUTE_BASE: routeBase },
      });
    },
  },
});
