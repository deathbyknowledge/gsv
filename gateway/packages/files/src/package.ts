import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Files",
    description: "File browser and workspace management.",
    window: {
      width: 1080,
      height: 760,
      minWidth: 780,
      minHeight: 520,
    },
    capabilities: {
      kernel: ["fs.read", "fs.search", "fs.write", "fs.edit", "fs.delete", "sys.device.list"],
    },
  },
  app: {
    async fetch(request, ctx) {
      const routeBase = ctx.meta.routeBase ?? "/apps/files";
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
