import { definePackage } from "@gsv/package/worker";
import LegacyChatApp from "../ui/worker";

function createLegacyEntrypointContext(ctx: {
  meta: { packageId: string; routeBase: string | null };
  kernel: unknown;
  package: unknown;
}) {
  const routeBase = ctx.meta.routeBase ?? "/apps/chat";
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
    displayName: "Chat",
    description: "Conversational workspace with agents.",
    window: {
      width: 880,
      height: 640,
      minWidth: 620,
      minHeight: 420,
    },
    capabilities: {
      kernel: ["proc.spawn", "proc.send", "proc.history", "sys.workspace.list"],
    },
  },
  app: {
    async fetch(request, ctx) {
      return LegacyChatApp.prototype.fetch.call(createLegacyEntrypointContext(ctx), request);
    },
  },
});
