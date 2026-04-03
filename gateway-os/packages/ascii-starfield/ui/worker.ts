import { WorkerEntrypoint } from "cloudflare:workers";
import indexHtml from "./index.html";
import starfieldWorkerSource from "./ascii-starfield-worker.js";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
};

const JS_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "no-store",
};

export default class AsciiStarfieldApp extends WorkerEntrypoint {
  async fetch(request) {
    const appFrame = this.ctx.props.appFrame;
    const routeBase = appFrame?.routeBase ?? this.env.PACKAGE_ROUTE_BASE ?? "/apps/ascii-starfield";
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === routeBase) {
      return Response.redirect(`${url.origin}${routeBase}/`, 302);
    }

    if (url.pathname === `${routeBase}/` || url.pathname === `${routeBase}/index.html`) {
      return new Response(request.method === "HEAD" ? null : indexHtml, {
        headers: HTML_HEADERS,
      });
    }

    if (url.pathname === `${routeBase}/ascii-starfield-worker.js`) {
      return new Response(request.method === "HEAD" ? null : starfieldWorkerSource, {
        headers: JS_HEADERS,
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
