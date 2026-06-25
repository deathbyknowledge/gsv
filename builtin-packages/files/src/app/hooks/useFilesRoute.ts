import { useCallback, useEffect, useState } from "preact/hooks";
import { defaultPathForTarget } from "../domain/paths";
import type { FilesRoute } from "../types";

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

function readRoute(): FilesRoute {
  const url = readLaunchUrl();
  const target = url.searchParams.get("target")?.trim() || "gsv";
  const nextRoute = {
    target,
    path: url.searchParams.get("path")?.trim() || defaultPathForTarget(target),
    q: url.searchParams.get("q")?.trim() || "",
    open: url.searchParams.get("open")?.trim() || "",
  };
  console.debug("[files] using url route", {
    route: nextRoute,
    href: window.location.href,
    launchHref: url.toString(),
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
