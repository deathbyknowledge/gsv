import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { getGatewayUrl, type UiSettings } from "../ui/storage";
import { TAB_GROUPS, TAB_ICONS, TAB_LABELS, type Tab } from "../ui/types";
import { useReactUiStore } from "./state/store";

const ChatView = lazy(() =>
  import("./views/ChatView").then((module) => ({ default: module.ChatView })),
);
const OverviewView = lazy(() =>
  import("./views/OverviewView").then((module) => ({
    default: module.OverviewView,
  })),
);
const SessionsView = lazy(() =>
  import("./views/SessionsView").then((module) => ({
    default: module.SessionsView,
  })),
);
const ChannelsView = lazy(() =>
  import("./views/ChannelsView").then((module) => ({
    default: module.ChannelsView,
  })),
);
const NodesView = lazy(() =>
  import("./views/NodesView").then((module) => ({ default: module.NodesView })),
);
const WorkspaceView = lazy(() =>
  import("./views/WorkspaceView").then((module) => ({
    default: module.WorkspaceView,
  })),
);
const CronView = lazy(() =>
  import("./views/CronView").then((module) => ({ default: module.CronView })),
);
const LogsView = lazy(() =>
  import("./views/LogsView").then((module) => ({ default: module.LogsView })),
);
const PairingView = lazy(() =>
  import("./views/PairingView").then((module) => ({
    default: module.PairingView,
  })),
);
const ConfigView = lazy(() =>
  import("./views/ConfigView").then((module) => ({
    default: module.ConfigView,
  })),
);
const DebugView = lazy(() =>
  import("./views/DebugView").then((module) => ({ default: module.DebugView })),
);

export function App() {
  const initialize = useReactUiStore((s) => s.initialize);
  const cleanup = useReactUiStore((s) => s.cleanup);
  const syncTabFromLocation = useReactUiStore((s) => s.syncTabFromLocation);
  const setMobileLayout = useReactUiStore((s) => s.setMobileLayout);

  useEffect(() => {
    initialize();
    const media = window.matchMedia("(max-width: 960px)");
    const updateLayout = () => setMobileLayout(media.matches);
    updateLayout();
    media.addEventListener("change", updateLayout);

    return () => {
      media.removeEventListener("change", updateLayout);
      cleanup();
    };
  }, [cleanup, initialize, setMobileLayout]);

  useEffect(() => {
    const onPopState = () => syncTabFromLocation();
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [syncTabFromLocation]);

  const showConnectScreen = useReactUiStore((s) => s.showConnectScreen);
  if (showConnectScreen) {
    return <ConnectScreen />;
  }

  return <MainShell />;
}

function ConnectScreen() {
  const settings = useReactUiStore((s) => s.settings);
  const connectionState = useReactUiStore((s) => s.connectionState);
  const connectionError = useReactUiStore((s) => s.connectionError);
  const connect = useReactUiStore((s) => s.connect);
  const updateSettings = useReactUiStore((s) => s.updateSettings);

  const [gatewayUrl, setGatewayUrl] = useState(settings.gatewayUrl);
  const [token, setToken] = useState(settings.token);
  const [theme, setTheme] = useState<UiSettings["theme"]>(settings.theme);

  useEffect(() => {
    setGatewayUrl(settings.gatewayUrl);
    setToken(settings.token);
    setTheme(settings.theme);
  }, [settings.gatewayUrl, settings.token, settings.theme]);

  const isConnecting = connectionState === "connecting";

  return (
    <div className="connect-screen">
      <Surface className="connect-card">
        <div className="connect-header">
          <span className="connect-logo">⚡</span>
          <h1>GSV</h1>
          <p className="text-secondary">Gateway control UI</p>
        </div>
        <div className="connect-form">
          <Input
            label="Gateway URL"
            className="ui-input-fix"
            size="lg"
            value={gatewayUrl}
            placeholder={getGatewayUrl(settings)}
            onChange={(event) => setGatewayUrl(event.target.value)}
            disabled={isConnecting}
          />
          <SensitiveInput
            label="Auth Token"
            className="ui-sensitive-fix"
            size="lg"
            value={token}
            placeholder="Leave empty if no auth required"
            onValueChange={setToken}
            disabled={isConnecting}
          />
          <Select<string>
            label="Theme"
            hideLabel={false}
            value={theme}
            onValueChange={(value) => setTheme(value as UiSettings["theme"])}
          >
            <Select.Option value="dark">Dark</Select.Option>
            <Select.Option value="light">Light</Select.Option>
            <Select.Option value="system">System</Select.Option>
          </Select>
          {connectionError ? (
            <div className="connect-error">{connectionError}</div>
          ) : null}
          <Button
            variant="primary"
            className="connect-btn"
            loading={isConnecting}
            onClick={() => {
              updateSettings({ gatewayUrl, token, theme });
              connect();
            }}
          >
            Connect
          </Button>
        </div>
      </Surface>
    </div>
  );
}

function MainShell() {
  const tab = useReactUiStore((s) => s.tab);
  const switchTab = useReactUiStore((s) => s.switchTab);
  const isMobileLayout = useReactUiStore((s) => s.isMobileLayout);
  const navDrawerOpen = useReactUiStore((s) => s.navDrawerOpen);
  const toggleNavDrawer = useReactUiStore((s) => s.toggleNavDrawer);
  const closeNavDrawer = useReactUiStore((s) => s.closeNavDrawer);
  const connectionState = useReactUiStore((s) => s.connectionState);
  const updateSettings = useReactUiStore((s) => s.updateSettings);
  const settings = useReactUiStore((s) => s.settings);
  const disconnect = useReactUiStore((s) => s.disconnect);

  const connectionBadgeVariant = useMemo(() => {
    if (connectionState === "connected") {
      return "primary";
    }
    if (connectionState === "connecting") {
      return "outline";
    }
    return "destructive";
  }, [connectionState]);

  return (
    <div
      className={`app-shell ${isMobileLayout ? "mobile" : ""} ${
        navDrawerOpen ? "nav-open" : ""
      }`}
    >
      <button
        type="button"
        className={`nav-backdrop ${navDrawerOpen ? "open" : ""}`}
        onClick={() => closeNavDrawer()}
        aria-label="Close navigation menu"
      />
      <nav className={`nav-sidebar ${navDrawerOpen ? "open" : ""}`}>
        <div className="nav-header">
          <span className="nav-logo">⚡</span>
          <span className="nav-title">GSV</span>
        </div>

        <div className="nav-groups">
          {TAB_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.tabs.map((groupTab) => (
                <button
                  type="button"
                  className={`nav-item ${groupTab === tab ? "active" : ""}`}
                  key={groupTab}
                  onClick={() => switchTab(groupTab)}
                >
                  <span className="nav-item-icon">{TAB_ICONS[groupTab]}</span>
                  <span className="nav-item-label">{TAB_LABELS[groupTab]}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="nav-footer">
          <div className="connection-status">
            <Badge className="ui-badge-fix" variant={connectionBadgeVariant}>
              {connectionState}
            </Badge>
          </div>
        </div>
      </nav>

      <div className="main-content">
        <header className="topbar">
          <div className="topbar-title-wrap">
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              className="topbar-menu-btn"
              aria-label="Toggle navigation menu"
              title="Toggle navigation"
              onClick={() => toggleNavDrawer()}
            >
              ☰
            </Button>
            <h1 className="topbar-title">{TAB_LABELS[tab]}</h1>
          </div>
          <div className="topbar-actions">
            <Button
              variant="ghost"
              shape="square"
              aria-label="Toggle theme"
              title="Toggle theme"
              onClick={() =>
                updateSettings({
                  theme: settings.theme === "dark" ? "light" : "dark",
                })
              }
            >
              {settings.theme === "dark" ? "🌙" : "☀️"}
            </Button>
            <Button
              variant="secondary"
              className="ui-button-fix"
              size="base"
              onClick={() => disconnect()}
            >
              Disconnect
            </Button>
          </div>
        </header>

        <div className="page-content">
          <ReactTabView tab={tab} />
        </div>
      </div>
    </div>
  );
}

function ReactTabView({ tab }: { tab: Tab }) {
  return (
    <Suspense fallback={<TabLoadingFallback />}>
      {tab === "chat" ? <ChatView /> : null}
      {tab === "overview" ? <OverviewView /> : null}
      {tab === "sessions" ? <SessionsView /> : null}
      {tab === "channels" ? <ChannelsView /> : null}
      {tab === "nodes" ? <NodesView /> : null}
      {tab === "workspace" ? <WorkspaceView /> : null}
      {tab === "cron" ? <CronView /> : null}
      {tab === "logs" ? <LogsView /> : null}
      {tab === "pairing" ? <PairingView /> : null}
      {tab === "config" ? <ConfigView /> : null}
      {tab === "debug" ? <DebugView /> : null}
      {!TAB_LABELS[tab] ? (
        <div className="view-container">
          <Surface className="card">
            <div className="card-body">
              <p className="text-secondary">Unknown tab: {tab}</p>
            </div>
          </Surface>
        </div>
      ) : null}
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
