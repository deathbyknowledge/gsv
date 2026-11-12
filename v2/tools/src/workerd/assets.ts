/**
 * Serves the UI's files from a workerd disk directory the way Cloudflare's asset binding serves them to
 * the runtime: `/` is the page and every file carries its content type. Anything else is a 404 the edge
 * turns into the single-page app.
 */
const TYPES = new Map([
  ["css", "text/css; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["js", "text/javascript; charset=utf-8"],
  ["json", "application/json"],
  ["map", "application/json"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["txt", "text/plain; charset=utf-8"],
  ["wasm", "application/wasm"],
  ["webmanifest", "application/manifest+json"],
  ["webp", "image/webp"],
  ["woff2", "font/woff2"],
]);

type Disk = { fetch(request: Request): Promise<Response> };

export default {
  async fetch(request: Request, env: { DISK: Disk }): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    if (url.pathname.endsWith("/")) url.pathname += "index.html";
    // A directory answers with its listing, so only paths with an extension are files.
    const extension = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    const response = extension ? await env.DISK.fetch(new Request(url, { method: request.method })) : undefined;
    if (!extension || !response?.ok) {
      await response?.body?.cancel();
      return new Response("Not found", { status: 404 });
    }
    const headers = new Headers({ "Content-Type": TYPES.get(extension) ?? "application/octet-stream", "Cache-Control": "no-cache" });
    const length = response.headers.get("Content-Length");
    if (length) headers.set("Content-Length", length);
    return new Response(response.body, { headers });
  },
};
