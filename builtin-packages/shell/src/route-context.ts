import { consumePendingAppOpen, getAppClientId } from "@humansandmachines/gsv/sdk/host";
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

export function readWindowId(): string {
  return getAppClientId();
}

export function readRouteParams(windowId: string): ShellRoute {
  const url = readLaunchUrl();
  const routeFromUrl = {
    target: url.searchParams.get("target")?.trim() || null,
    cwd: url.searchParams.get("path")?.trim() || url.searchParams.get("cwd")?.trim() || null,
  };

  const pending = consumePendingAppOpen(windowId);
  if (pending?.target !== "shell") {
    return routeFromUrl;
  }

  const payload = pending.payload && typeof pending.payload === "object" ? pending.payload as Record<string, unknown> : null;
  const context = payload?.context && typeof payload.context === "object" ? payload.context as Record<string, unknown> : null;
  const target = (
    readPayloadString(payload, "device")
    ?? readPayloadString(payload, "deviceId")
    ?? readPayloadString(payload, "target")
    ?? routeFromUrl.target
  );
  const cwd = readPayloadString(payload, "cwd")
    ?? readPayloadString(context, "cwd")
    ?? routeFromUrl.cwd;

  return { target, cwd };
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

function readPayloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
