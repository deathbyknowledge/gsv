import { consumePendingAppOpen, getAppClientId } from "@gsv/package/host";
import { useCallback, useEffect, useState } from "preact/hooks";
import { defaultPathForTarget } from "../domain/paths";
import type { FilesRoute } from "../types";

const WINDOW_ID = getAppClientId();

function readFrameLaunchUrl(): URL | null {
  try {
    const frame = window.frameElement;
    if (!(frame instanceof HTMLIFrameElement)) {
      return null;
    }
    const raw = frame.getAttribute("src")?.trim() || frame.src?.trim() || "";
    if (!raw) {
      return null;
    }
    return new URL(raw, window.location.origin);
  } catch {
    return null;
  }
}

function readLaunchUrl(): URL {
  const current = new URL(window.location.href);
  const frame = readFrameLaunchUrl();
  if (!frame) {
    return current;
  }

  const currentHasExplicitState =
    current.searchParams.has("path")
    || current.searchParams.has("open")
    || current.searchParams.has("q")
    || current.searchParams.has("target");
  if (currentHasExplicitState) {
    return current;
  }

  const frameHasExplicitState =
    frame.searchParams.has("path")
    || frame.searchParams.has("open")
    || frame.searchParams.has("q")
    || frame.searchParams.has("target");
  if (!frameHasExplicitState) {
    return current;
  }

  return frame;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readTrimmedString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function readRequestedTarget(payload: Record<string, unknown> | null): string | null {
  return readTrimmedString(payload?.device) ?? readTrimmedString(payload?.deviceId) ?? readTrimmedString(payload?.target);
}

function readRouteFromUrl(): FilesRoute {
  const url = readLaunchUrl();
  const target = url.searchParams.get("target")?.trim() || "gsv";
  const nextRoute = {
    target,
    path: url.searchParams.get("path")?.trim() || defaultPathForTarget(target),
    q: url.searchParams.get("q")?.trim() || "",
    open: url.searchParams.get("open")?.trim() || "",
  };
  console.debug("[files] using url route", {
    windowId: WINDOW_ID,
    route: nextRoute,
    href: window.location.href,
    launchHref: url.toString(),
  });
  return nextRoute;
}

function readRoute(): FilesRoute {
  const nextFromUrl = readRouteFromUrl();
  const pending = consumePendingAppOpen(WINDOW_ID);
  if (pending?.target !== "files") {
    return nextFromUrl;
  }

  const payload = asRecord(pending.payload);
  const context = asRecord(payload?.context);
  const target = readRequestedTarget(payload) ?? nextFromUrl.target;
  const nextRoute = {
    target,
    path: readTrimmedString(payload?.path) ?? readTrimmedString(context?.cwd) ?? nextFromUrl.path,
    q: readTrimmedString(payload?.q) ?? nextFromUrl.q,
    open: readTrimmedString(payload?.open) ?? nextFromUrl.open,
  };
  console.debug("[files] consumed pending app open", {
    windowId: WINDOW_ID,
    pending,
    route: nextRoute,
  });
  return nextRoute;
}

function writeRoute(route: FilesRoute, replace = false) {
  const url = new URL(window.location.href);
  for (const key of ["target", "path", "q", "open"] as const) {
    const value = route[key];
    if (value) {
      url.searchParams.set(key, value);
    } else {
      url.searchParams.delete(key);
    }
  }
  window.history[replace ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function useFilesRoute() {
  const [route, setRoute] = useState<FilesRoute>(() => readRoute());

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextRoute: FilesRoute, replace = false) => {
    writeRoute(nextRoute, replace);
    setRoute(nextRoute);
  }, []);

  return { route, navigate };
}
