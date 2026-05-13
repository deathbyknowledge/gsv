import { sectionExists } from "./sections";
import type { GsvSectionId } from "./types";

export type SourcesRoute = {
  repo: string;
  ref?: string;
  path?: string;
  mode?: "code" | "history";
};

export type PackagesRouteView = "inventory" | "updates" | "review";

export type PackagesRoute = {
  packageId?: string | null;
  view?: PackagesRouteView;
};

export function readSectionFromLocation(): GsvSectionId {
  const value = new URL(window.location.href).searchParams.get("section") ?? "";
  return sectionExists(value) ? value : "overview";
}

export function readPackagesViewFromLocation(): PackagesRouteView {
  const value = new URL(window.location.href).searchParams.get("view");
  return value === "updates" || value === "review" ? value : "inventory";
}

export function readPackageFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get("package");
  return value?.trim() || null;
}

export function pushSectionLocation(sectionId: GsvSectionId): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", sectionId);
  window.history.pushState({}, "", url);
}

export function pushPackagesLocation(route: PackagesRoute): void {
  writePackagesLocation(route, "push");
}

export function replacePackagesLocation(route: PackagesRoute): void {
  writePackagesLocation(route, "replace");
}

export function pushSourcesLocation(route: SourcesRoute): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "sources");
  url.searchParams.set("repo", route.repo);
  setOptionalParam(url, "ref", route.ref);
  setOptionalParam(url, "path", route.path && route.path !== "." ? route.path : undefined);
  if (route.mode && route.mode !== "code") {
    url.searchParams.set("mode", route.mode);
  } else {
    url.searchParams.delete("mode");
  }
  window.history.pushState({}, "", url);
}

function writePackagesLocation(route: PackagesRoute, update: "push" | "replace"): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "packages");
  if (route.view) {
    url.searchParams.set("view", route.view);
  }
  if (route.packageId !== undefined) {
    setOptionalParam(url, "package", route.packageId ?? undefined);
  }
  if (update === "push") {
    window.history.pushState({}, "", url);
  } else {
    window.history.replaceState({}, "", url);
  }
}

function setOptionalParam(url: URL, key: string, value: string | undefined): void {
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
}
