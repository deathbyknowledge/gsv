export function createBuiltinEmbeddedAppWorkerSource(appId: string): string {
  return [
    "import { WorkerEntrypoint } from \"cloudflare:workers\";",
    "",
    "export default class EmbeddedAppRedirect extends WorkerEntrypoint {",
    "  async fetch(request) {",
    "    const url = new URL(request.url);",
    "    const routeBase = this.env.PACKAGE_ROUTE_BASE ?? \"/apps/app\";",
    "    if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {",
    "      return new Response(\"Not Found\", { status: 404 });",
    "    }",
    `    const target = new URL("/?embeddedApp=${appId}", url);`,
    "    return Response.redirect(target.toString(), 302);",
    "  }",
    "}",
  ].join("\n");
}
