/**
 * Navigation utilities
 */

import type { Tab } from "./types";

const TAB_PATHS: Record<Tab, string> = {
  chat: "/chat",
  overview: "/overview",
  sessions: "/sessions",
  channels: "/channels",
  nodes: "/nodes",
  workspace: "/workspace",
  cron: "/cron",
  logs: "/logs",
  pairing: "/pairing",
  config: "/config",
  debug: "/debug",
  settings: "/settings",
};

const PATH_TABS: Record<string, Tab> = Object.fromEntries(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab])
);

export function tabFromPath(path: string): Tab {
  return PATH_TABS[path] || "chat";
}

export function pathForTab(tab: Tab): string {
  return TAB_PATHS[tab] || "/chat";
}

export function navigateTo(tab: Tab): void {
  const path = pathForTab(tab);
  if (window.location.pathname !== path) {
    window.history.pushState({ tab }, "", path);
  }
}

export function getCurrentTab(): Tab {
  return tabFromPath(window.location.pathname);
}
