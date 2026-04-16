import { openApp } from "@gsv/package/host";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { DeviceAccess } from "./device-access";
import { DeviceCapabilities } from "./device-capabilities";
import { DeviceHealth } from "./device-health";
import { DeviceList } from "./device-list";
import { DeviceOverview } from "./device-overview";
import { ProvisionPanel } from "./provision-panel";
import type {
  CreateNodeTokenArgs,
  DevicesBackend,
  DevicesMode,
  DevicesState,
  DevicesTabId,
  DeviceScope,
  IssuedNodeToken,
} from "./types";

type AppProps = {
  backend: DevicesBackend;
};

export function App({ backend }: AppProps) {
  const [state, setState] = useState<DevicesState | null>(null);
  const [mode, setMode] = useState<DevicesMode>(readModeFromLocation());
  const [activeTab, setActiveTab] = useState<DevicesTabId>(readTabFromLocation());
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(readDeviceFromLocation());
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<DeviceScope>("all");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<IssuedNodeToken | null>(null);

  const updateRoute = useCallback((next: { mode?: DevicesMode; tab?: DevicesTabId; deviceId?: string | null }) => {
    const url = new URL(window.location.href);
    const nextMode = next.mode ?? mode;
    const nextTab = next.tab ?? activeTab;
    const nextDeviceId = next.deviceId === undefined ? selectedDeviceId : next.deviceId;

    url.searchParams.set("mode", nextMode);
    url.searchParams.set("tab", nextTab);
    if (nextDeviceId) {
      url.searchParams.set("device", nextDeviceId);
    } else {
      url.searchParams.delete("device");
    }

    window.history.pushState({}, "", url);
    setMode(nextMode);
    setActiveTab(nextTab);
    setSelectedDeviceId(nextDeviceId ?? null);
  }, [activeTab, mode, selectedDeviceId]);

  const refresh = useCallback(async (deviceId: string | null) => {
    setPendingAction("load-state");
    try {
      const nextState = await backend.loadState(deviceId ? { deviceId } : {});
      setState(nextState);
      if (nextState.selectedDeviceId !== selectedDeviceId) {
        updateRoute({ deviceId: nextState.selectedDeviceId });
      }
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }, [backend, selectedDeviceId, updateRoute]);

  useEffect(() => {
    void refresh(selectedDeviceId);
  }, [refresh, selectedDeviceId]);

  useEffect(() => {
    const onPopState = () => {
      setMode(readModeFromLocation());
      setActiveTab(readTabFromLocation());
      setSelectedDeviceId(readDeviceFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectedDevice = state?.selectedDevice ?? null;
  const selectedId = state?.selectedDeviceId ?? selectedDeviceId;
  const canManageTokens = state?.viewer.canManageTokens ?? false;

  async function handleCreateToken(form: { deviceId: string; label: string; expiresDays: string }): Promise<void> {
    setPendingAction("create-token");
    try {
      const days = Number(form.expiresDays || "30");
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error("Expiry must be a positive number of days.");
      }
      const args: CreateNodeTokenArgs = {
        deviceId: form.deviceId,
        label: form.label,
        expiresAt: Date.now() + (days * 24 * 60 * 60 * 1000),
      };
      const result = await backend.createNodeToken(args);
      setState(result.state);
      setSelectedDeviceId(result.state.selectedDeviceId);
      setIssuedToken(result.token);
      setMode("provision");
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRevokeToken(tokenId: string): Promise<void> {
    setPendingAction(`revoke:${tokenId}`);
    try {
      const nextState = await backend.revokeToken({
        tokenId,
        ...(selectedId ? { deviceId: selectedId } : {}),
      });
      setState(nextState);
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }

  const detailContent = useMemo(() => {
    if (!state) {
      return <section class="devices-detail-empty">Loading fleet…</section>;
    }

    if (mode === "provision") {
      if (!state.viewer.canManageTokens) {
        return (
          <section class="devices-detail-empty">
            <h2>Provisioning unavailable</h2>
            <p>Only root can issue node tokens and enroll new devices.</p>
          </section>
        );
      }
      return (
        <ProvisionPanel
          initialDeviceId={selectedId ?? ""}
          viewerUsername={state.viewer.username}
          pendingAction={pendingAction}
          issuedToken={issuedToken}
          onBack={() => updateRoute({ mode: "detail" })}
          onSubmit={(form) => void handleCreateToken(form)}
        />
      );
    }

    if (!selectedDevice) {
      return (
        <section class="devices-detail-empty">
          <h2>No device selected</h2>
          <p>Choose a device from the fleet list or issue a token for the next machine you want to connect.</p>
        </section>
      );
    }

    return (
      <section class="devices-detail-pane">
        <header class="devices-detail-head">
          <div>
            <p class="devices-eyebrow">Fleet detail</p>
            <h2>{selectedDevice.deviceId}</h2>
            <p>{selectedDevice.online ? "Online and ready for routing." : "Offline. Review health and access before routing work here."}</p>
          </div>
          <div class="devices-inline-actions">
            <button
              class="devices-button devices-button--quiet devices-icon-btn"
              type="button"
              title="Open in Files"
              aria-label="Open in Files"
              onClick={() => openApp({ target: "files", payload: { device: selectedDevice.deviceId, path: "." } })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2H21v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            </button>
            <button
              class="devices-button devices-button--quiet devices-icon-btn"
              type="button"
              title="Open Shell"
              aria-label="Open Shell"
              onClick={() => openApp({ target: "shell", payload: { device: selectedDevice.deviceId, workdir: "." } })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" /><path d="m7 10 3 2.5L7 15" /><path d="M12.5 15H17" /></svg>
            </button>
            {state.viewer.canManageTokens ? (
              <button class="devices-button devices-button--primary" onClick={() => { setIssuedToken(null); updateRoute({ mode: "provision", deviceId: selectedDevice.deviceId }); }}>
                Add access
              </button>
            ) : null}
          </div>
        </header>

        <nav class="devices-tabbar" aria-label="Device detail tabs">
          {([
            ["overview", "Overview"],
            ["capabilities", "Capabilities"],
            ["access", "Access"],
            ["health", "Health"],
          ] as Array<[DevicesTabId, string]>).map(([tabId, label]) => (
            <button
              key={tabId}
              class={`devices-tab${activeTab === tabId ? " is-active" : ""}`}
              onClick={() => updateRoute({ tab: tabId })}
            >
              {label}
            </button>
          ))}
        </nav>

        {activeTab === "overview" ? <DeviceOverview device={selectedDevice} /> : null}
        {activeTab === "capabilities" ? <DeviceCapabilities device={selectedDevice} /> : null}
        {activeTab === "access" ? (
          <DeviceAccess
            viewer={state.viewer}
            device={selectedDevice}
            tokens={state.deviceTokens}
            pendingAction={pendingAction}
            onProvision={(deviceId) => {
              setIssuedToken(null);
              updateRoute({ mode: "provision", deviceId });
            }}
            onRevoke={(tokenId) => void handleRevokeToken(tokenId)}
          />
        ) : null}
        {activeTab === "health" ? <DeviceHealth device={selectedDevice} /> : null}
      </section>
    );
  }, [activeTab, handleCreateToken, issuedToken, mode, pendingAction, selectedDevice, selectedId, state, updateRoute]);

  return (
    <div class="devices-app">
      {error ? <div class="devices-error-banner">{error}</div> : null}
      <div class="devices-layout">
        <DeviceList
          devices={state?.devices ?? []}
          canManageTokens={canManageTokens}
          selectedDeviceId={selectedId}
          query={query}
          scope={scope}
          onQueryChange={setQuery}
          onScopeChange={setScope}
          onSelectDevice={(deviceId) => {
            setIssuedToken(null);
            updateRoute({ mode: "detail", deviceId });
          }}
          onStartProvision={() => {
            setIssuedToken(null);
            updateRoute({ mode: "provision" });
          }}
        />
        <main class="devices-main">{detailContent}</main>
      </div>
    </div>
  );
}

function readTabFromLocation(): DevicesTabId {
  const value = new URL(window.location.href).searchParams.get("tab");
  return value === "capabilities" || value === "access" || value === "health" ? value : "overview";
}

function readModeFromLocation(): DevicesMode {
  return new URL(window.location.href).searchParams.get("mode") === "provision" ? "provision" : "detail";
}

function readDeviceFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get("device");
  return value && value.trim().length > 0 ? value.trim() : null;
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
