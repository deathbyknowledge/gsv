import { useEffect, useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { getGatewayUrl, type UiSettings } from "../ui/storage";
import { TAB_GROUPS, TAB_ICONS, TAB_LABELS } from "../ui/types";
import { OsShell } from "./components/OsShell";
import { useReactUiStore } from "./state/store";
import { preloadTabView, TabView } from "./tabViews";

type LayoutMode = "classic" | "os";

const LAYOUT_MODE_STORAGE_KEY = "gsv-layout-mode";
const LAYOUT_MODE_QUERY_PARAM = "shell";

function getInitialLayoutMode(): LayoutMode {
  if (typeof window === "undefined") {
    return "classic";
  }

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get(LAYOUT_MODE_QUERY_PARAM) === "os") {
    return "os";
  }

  const stored = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
  return stored === "os" ? "os" : "classic";
}

function persistLayoutMode(mode: LayoutMode): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, mode);
  const url = new URL(window.location.href);
  if (mode === "os") {
    url.searchParams.set(LAYOUT_MODE_QUERY_PARAM, "os");
  } else {
    url.searchParams.delete(LAYOUT_MODE_QUERY_PARAM);
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function App() {
  const initialize = useReactUiStore((s) => s.initialize);
  const cleanup = useReactUiStore((s) => s.cleanup);
  const syncTabFromLocation = useReactUiStore((s) => s.syncTabFromLocation);
  const setMobileLayout = useReactUiStore((s) => s.setMobileLayout);
  const showConnectScreen = useReactUiStore((s) => s.showConnectScreen);
  const tab = useReactUiStore((s) => s.tab);
  const switchTab = useReactUiStore((s) => s.switchTab);
  const isMobileLayout = useReactUiStore((s) => s.isMobileLayout);
  const connectionState = useReactUiStore((s) => s.connectionState);
  const updateSettings = useReactUiStore((s) => s.updateSettings);
  const settings = useReactUiStore((s) => s.settings);
  const disconnect = useReactUiStore((s) => s.disconnect);

  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() =>
    getInitialLayoutMode(),
  );

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

  useEffect(() => {
    persistLayoutMode(layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    if (layoutMode === "os" && isMobileLayout) {
      setLayoutMode("classic");
    }
  }, [isMobileLayout, layoutMode]);

  useEffect(() => {
    preloadTabView(tab);
  }, [tab]);

  if (showConnectScreen) {
    return <ConnectScreen />;
  }

  if (layoutMode === "os" && !isMobileLayout) {
    return (
      <OsShell
        tab={tab}
        onSwitchTab={switchTab}
        connectionState={connectionState}
        theme={settings.theme}
        onToggleTheme={() =>
          updateSettings({
            theme: settings.theme === "dark" ? "light" : "dark",
          })
        }
        onDisconnect={disconnect}
        onExitOsMode={() => setLayoutMode("classic")}
      />
    );
  }

  return (
    <MainShell
      osModeAvailable={!isMobileLayout}
      onEnableOsMode={() => setLayoutMode("os")}
    />
  );
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

function MainShell({
  osModeAvailable,
  onEnableOsMode,
}: {
  osModeAvailable: boolean;
  onEnableOsMode: () => void;
}) {
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
                  onMouseEnter={() => preloadTabView(groupTab)}
                  onFocus={() => preloadTabView(groupTab)}
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
            {osModeAvailable ? (
              <Button
                variant="secondary"
                className="ui-button-fix"
                size="base"
                onClick={onEnableOsMode}
              >
                OS mode
              </Button>
            ) : null}
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
          <TabView tab={tab} />
        </div>
      </div>
    </div>
  );
}
