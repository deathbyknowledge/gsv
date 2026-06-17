import type { ShellRoute } from "./types";

export function readLaunchUrl(): URL {
  const current = new URL(window.location.href);
  const frame = readFrameLaunchUrl();
  if (!frame) {
    return current;
  }

  const currentHasExplicitState = hasExplicitShellState(current);
  if (currentHasExplicitState) {
    return current;
  }

  const frameHasExplicitState = hasExplicitShellState(frame);
  if (!frameHasExplicitState) {
    return current;
  }

  return frame;
}

export function readRouteParams(): ShellRoute {
  const url = readLaunchUrl();
  return {
    target: url.searchParams.get("target")?.trim() || null,
    cwd: url.searchParams.get("path")?.trim() || url.searchParams.get("cwd")?.trim() || null,
  };
}

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

function hasExplicitShellState(url: URL): boolean {
  return url.searchParams.has("target") || url.searchParams.has("path") || url.searchParams.has("cwd");
}
