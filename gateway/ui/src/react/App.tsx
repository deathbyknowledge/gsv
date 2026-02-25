import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { getGatewayUrl, type UiSettings } from "../ui/storage";
import { OsShell } from "./components/OsShell";
import { useReactUiStore } from "./state/store";
import { preloadTabView } from "./tabViews";

export function App() {
  const initialize = useReactUiStore((s) => s.initialize);
  const cleanup = useReactUiStore((s) => s.cleanup);
  const syncTabFromLocation = useReactUiStore((s) => s.syncTabFromLocation);
  const showConnectScreen = useReactUiStore((s) => s.showConnectScreen);
  const tab = useReactUiStore((s) => s.tab);
  const switchTab = useReactUiStore((s) => s.switchTab);
  const connectionState = useReactUiStore((s) => s.connectionState);
  const updateSettings = useReactUiStore((s) => s.updateSettings);
  const settings = useReactUiStore((s) => s.settings);
  const disconnect = useReactUiStore((s) => s.disconnect);

  useEffect(() => {
    initialize();
    return () => {
      cleanup();
    };
  }, [cleanup, initialize]);

  useEffect(() => {
    const onPopState = () => syncTabFromLocation();
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [syncTabFromLocation]);

  useEffect(() => {
    preloadTabView(tab);
  }, [tab]);

  if (showConnectScreen) {
    return <ConnectScreen />;
  }

  return (
    <OsShell
      tab={tab}
      onSwitchTab={switchTab}
      connectionState={connectionState}
      theme={settings.theme}
      wallpaper={settings.wallpaper ?? "starfield"}
      onToggleTheme={() =>
        updateSettings({
          theme: settings.theme === "dark" ? "light" : "dark",
        })
      }
      onChangeWallpaper={(wp) => updateSettings({ wallpaper: wp })}
      onDisconnect={disconnect}
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
          <span className="connect-logo">GSV</span>
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
