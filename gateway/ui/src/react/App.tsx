import { useEffect, useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { getGatewayUrl, type UiSettings } from "../ui/storage";
import { TAB_GROUPS, TAB_ICONS, TAB_LABELS, type Tab } from "../ui/types";
import { useReactUiStore } from "./state/store";

export function App() {
  const initialize = useReactUiStore((s) => s.initialize);
  const syncTabFromLocation = useReactUiStore((s) => s.syncTabFromLocation);

  useEffect(() => {
    initialize();
  }, [initialize]);

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
          <h1>GSV React</h1>
          <p className="text-secondary">Migration preview (`?ui=react`)</p>
        </div>
        <div className="connect-form">
          <Input
            label="Gateway URL"
            value={gatewayUrl}
            placeholder={getGatewayUrl(settings)}
            onChange={(event) => setGatewayUrl(event.target.value)}
            disabled={isConnecting}
          />
          <SensitiveInput
            label="Auth Token"
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
  const setTab = useReactUiStore((s) => s.setTab);
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
    <div className="app-shell">
      <nav className="nav-sidebar">
        <div className="nav-header">
          <span className="nav-logo">⚡</span>
          <span className="nav-title">GSV React</span>
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
                  onClick={() => setTab(groupTab)}
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
            <Badge variant={connectionBadgeVariant}>{connectionState}</Badge>
          </div>
        </div>
      </nav>

      <div className="main-content">
        <header className="topbar">
          <div className="topbar-title-wrap">
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
              size="sm"
              onClick={() => disconnect()}
            >
              Disconnect
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.delete("ui");
                window.location.href = url.toString();
              }}
            >
              Use Lit UI
            </Button>
          </div>
        </header>

        <div className="page-content">
          <ReactTabPlaceholder tab={tab} />
        </div>
      </div>
    </div>
  );
}

function ReactTabPlaceholder({ tab }: { tab: Tab }) {
  return (
    <div className="view-container">
      <Surface className="card">
        <div className="card-header">
          <h3 className="card-title">{TAB_LABELS[tab]}</h3>
          <Badge variant="secondary">React migration</Badge>
        </div>
        <div className="card-body">
          <p className="text-secondary">
            This tab is not migrated yet. Phase 1 starts with full Config migration
            using Kumo controls, then tab-by-tab parity.
          </p>
        </div>
      </Surface>
    </div>
  );
}
