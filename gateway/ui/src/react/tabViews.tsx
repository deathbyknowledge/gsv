import { Surface } from "@cloudflare/kumo/components/surface";
import {
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { type Tab } from "../ui/types";

type TabViewModule = { default: ComponentType };
type TabViewLoader = () => Promise<TabViewModule>;

const TAB_VIEW_LOADERS: Record<Tab, TabViewLoader> = {
  chat: () =>
    import("./views/ChatView").then((module) => ({ default: module.ChatView })),
  overview: () =>
    import("./views/OverviewView").then((module) => ({
      default: module.OverviewView,
    })),
  sessions: () =>
    import("./views/SessionsView").then((module) => ({
      default: module.SessionsView,
    })),
  channels: () =>
    import("./views/ChannelsView").then((module) => ({
      default: module.ChannelsView,
    })),
  nodes: () =>
    import("./views/NodesView").then((module) => ({ default: module.NodesView })),
  workspace: () =>
    import("./views/WorkspaceView").then((module) => ({
      default: module.WorkspaceView,
    })),
  cron: () =>
    import("./views/CronView").then((module) => ({ default: module.CronView })),
  logs: () =>
    import("./views/LogsView").then((module) => ({ default: module.LogsView })),
  pairing: () =>
    import("./views/PairingView").then((module) => ({
      default: module.PairingView,
    })),
  config: () =>
    import("./views/ConfigView").then((module) => ({
      default: module.ConfigView,
    })),
  debug: () =>
    import("./views/DebugView").then((module) => ({ default: module.DebugView })),
};

const TAB_VIEW_COMPONENTS: Record<Tab, LazyExoticComponent<ComponentType>> = {
  chat: lazy(TAB_VIEW_LOADERS.chat),
  overview: lazy(TAB_VIEW_LOADERS.overview),
  sessions: lazy(TAB_VIEW_LOADERS.sessions),
  channels: lazy(TAB_VIEW_LOADERS.channels),
  nodes: lazy(TAB_VIEW_LOADERS.nodes),
  workspace: lazy(TAB_VIEW_LOADERS.workspace),
  cron: lazy(TAB_VIEW_LOADERS.cron),
  logs: lazy(TAB_VIEW_LOADERS.logs),
  pairing: lazy(TAB_VIEW_LOADERS.pairing),
  config: lazy(TAB_VIEW_LOADERS.config),
  debug: lazy(TAB_VIEW_LOADERS.debug),
};

const preloadedTabs = new Set<Tab>();

export function preloadTabView(tab: Tab): void {
  if (preloadedTabs.has(tab)) {
    return;
  }
  preloadedTabs.add(tab);
  void TAB_VIEW_LOADERS[tab]();
}

export function TabView({ tab }: { tab: Tab }) {
  const View = TAB_VIEW_COMPONENTS[tab];
  return (
    <Suspense fallback={<TabLoadingFallback />}>
      {View ? (
        <View />
      ) : (
        <div className="view-container">
          <Surface className="card">
            <div className="card-body">
              <p className="text-secondary">Unknown tab: {tab}</p>
            </div>
          </Surface>
        </div>
      )}
    </Suspense>
  );
}

function TabLoadingFallback() {
  return (
    <div className="view-container">
      <Surface className="card">
        <div className="card-body">
          <div className="thinking-indicator">
            <span className="spinner"></span>
            <span>Loading view...</span>
          </div>
        </div>
      </Surface>
    </div>
  );
}
