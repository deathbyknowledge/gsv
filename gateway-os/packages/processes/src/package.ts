import { definePackage } from "@gsv/package/worker";
import LegacyProcessesApp from "../ui/worker";

function createLegacyEntrypointContext(ctx: {
  meta: { packageId: string; routeBase: string | null };
  kernel: unknown;
  package: unknown;
}) {
  const routeBase = ctx.meta.routeBase ?? "/apps/processes";
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
    displayName: "Processes",
    description: "Inspect and manage running agent processes.",
    window: {
      width: 920,
      height: 620,
      minWidth: 700,
      minHeight: 440,
    },
    capabilities: {
      kernel: ["proc.list", "proc.kill"],
    },
  },
  app: {
    async fetch(request, ctx) {
      return LegacyProcessesApp.prototype.fetch.call(createLegacyEntrypointContext(ctx), request);
    },
  },
});
