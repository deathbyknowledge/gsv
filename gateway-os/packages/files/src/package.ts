import { definePackage } from "@gsv/package/worker";
import { handleFetch } from "../ui/worker";

export default definePackage({
  meta: {
    displayName: "Files",
    description: "File browser and workspace management.",
    window: {
      width: 980,
      height: 650,
      minWidth: 720,
      minHeight: 460,
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
          package: ctx.package,
        },
        env: { PACKAGE_ROUTE_BASE: routeBase },
      });
    },
  },
});
