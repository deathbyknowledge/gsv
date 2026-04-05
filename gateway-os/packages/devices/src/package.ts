import { definePackage } from "@gsv/package/worker";
import LegacyDevicesApp from "../ui/worker";

function createLegacyEntrypointContext(ctx: {
  meta: { packageId: string; routeBase: string | null };
  kernel: unknown;
  package: unknown;
}) {
  const routeBase = ctx.meta.routeBase ?? "/apps/devices";
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
    displayName: "Devices",
    description: "Connected machine inventory and runtime device status.",
    window: {
      width: 940,
      height: 620,
      minWidth: 720,
      minHeight: 460,
    },
    capabilities: {
      kernel: ["sys.device.list", "sys.device.get"],
    },
  },
  app: {
    async fetch(request, ctx) {
      return LegacyDevicesApp.prototype.fetch.call(createLegacyEntrypointContext(ctx), request);
    },
  },
});
