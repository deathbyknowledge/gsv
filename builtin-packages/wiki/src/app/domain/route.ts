import type { WikiMode } from "../types";

export type WikiRoute = {
  db?: string;
  path?: string;
  q?: string;
};

export function readMode(): WikiMode {
  const value = new URL(window.location.href).searchParams.get("mode");
  return value === "edit" || value === "build" || value === "ingest" ? value : "browse";
}

export function readRoute(): WikiRoute {
  const url = new URL(window.location.href);
  const read = (key: string) => {
    const value = url.searchParams.get(key);
    return value && value.trim() ? value.trim() : undefined;
  };
  return {
    db: read("db"),
    path: read("path"),
    q: read("q"),
  };
}

export function writeLocation(mode: WikiMode, route: WikiRoute): void {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  writeParam(url, "db", route.db);
  writeParam(url, "path", route.path);
  writeParam(url, "q", route.q);
  url.searchParams.delete("ask");
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

export function buildWikiHref(mode: WikiMode, route: WikiRoute): string {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  writeParam(url, "db", route.db);
  writeParam(url, "path", route.path);
  writeParam(url, "q", route.q);
  url.searchParams.delete("ask");
  return `${url.pathname}${url.search}`;
}

function writeParam(url: URL, key: string, value: string | undefined): void {
  if (value && value.trim()) {
    url.searchParams.set(key, value.trim());
  } else {
    url.searchParams.delete(key);
  }
}
