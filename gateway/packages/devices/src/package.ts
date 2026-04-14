import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Devices",
    description: "Connected machine inventory and runtime device status.",
    window: {
      width: 940,
      height: 620,
      minWidth: 720,
      minHeight: 460,
    },
    capabilities: {
      kernel: ["sys.device.list", "sys.device.get", "sys.token.create"],
    },
  },
  app: {
    async fetch(request, ctx) {
      const routeBase = ctx.meta.routeBase ?? "/apps/devices";
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
