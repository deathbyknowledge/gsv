import gateway from "./index";

export * from "./index";

type ManagedDevelopmentEnv = Env & {
  ACCOUNT_HTTP: Fetcher;
  GSV_ACCOUNT_ORIGIN: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === env.GSV_ACCOUNT_ORIGIN) {
      return await env.ACCOUNT_HTTP.fetch(request);
    }
    if (!url.hostname.endsWith(".localhost")) {
      return new Response("Not Found", { status: 404 });
    }
    // SAFETY: the development gateway accepts the standard Worker fetch request shape.
    return await gateway.fetch(
      request as Parameters<typeof gateway.fetch>[0],
      env,
    );
  },
} satisfies ExportedHandler<ManagedDevelopmentEnv>;
