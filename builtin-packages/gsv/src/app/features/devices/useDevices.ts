import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import { filterDevices } from "./devices-domain";
import type {
  CreateNodeTokenArgs,
  DeviceScope,
  DevicesMode,
  DevicesState,
  DevicesTabId,
  IssuedNodeToken,
} from "./types";

export function useDevices(backend: GsvBackend) {
  const [state, setState] = useState<DevicesState | null>(null);
  const [mode, setMode] = useState<DevicesMode>(readModeFromLocation);
  const [activeTab, setActiveTab] = useState<DevicesTabId>(readTabFromLocation);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(readDeviceFromLocation);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<DeviceScope>("all");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<IssuedNodeToken | null>(null);

  const writeRoute = useCallback((next: { mode?: DevicesMode; tab?: DevicesTabId; deviceId?: string | null }) => {
    const url = new URL(window.location.href);
    const nextMode = next.mode ?? mode;
    const nextTab = next.tab ?? activeTab;
    const nextDeviceId = next.deviceId === undefined ? selectedDeviceId : next.deviceId;

    url.searchParams.set("section", "devices");
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

  const loadState = useCallback(async (deviceId: string | null) => {
    setPendingAction("load-state");
    try {
      const nextState = await backend.loadDevicesState(deviceId ? { deviceId } : {});
      setState(nextState);
      setErrorText(null);
      if (nextState.selectedDeviceId !== selectedDeviceId) {
        writeRoute({ deviceId: nextState.selectedDeviceId });
      }
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setPendingAction(null);
    }
  }, [backend, selectedDeviceId, writeRoute]);

  useEffect(() => {
    void loadState(selectedDeviceId);
  }, [loadState, selectedDeviceId]);

  useEffect(() => {
    const onPopState = () => {
      setMode(readModeFromLocation());
      setActiveTab(readTabFromLocation());
      setSelectedDeviceId(readDeviceFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const visibleDevices = useMemo(() => filterDevices(state?.devices ?? [], scope, query), [query, scope, state?.devices]);

  async function createToken(form: { deviceId: string; label: string; expiresDays: string }): Promise<void> {
    setPendingAction("create-token");
    try {
      const days = Number(form.expiresDays || "30");
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error("Expiry must be a positive number of days.");
      }
      const args: CreateNodeTokenArgs = {
        deviceId: form.deviceId,
        label: form.label,
        expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
      };
      const result = await backend.createDeviceNodeToken(args);
      setState(result.state);
      setSelectedDeviceId(result.state.selectedDeviceId);
      setMode("provision");
      setIssuedToken(result.token);
      setErrorText(null);
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function revokeToken(tokenId: string): Promise<void> {
    setPendingAction(`revoke:${tokenId}`);
    try {
      const nextState = await backend.revokeDeviceToken({
        tokenId,
        ...(state?.selectedDeviceId ? { deviceId: state.selectedDeviceId } : {}),
      });
      setState(nextState);
      setErrorText(null);
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function updateDescription(deviceId: string, description: string): Promise<void> {
    setPendingAction("update-description");
    try {
      const nextState = await backend.updateDeviceDescription({ deviceId, description });
      setState(nextState);
      setErrorText(null);
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setPendingAction(null);
    }
  }

  return {
    state,
    mode,
    activeTab,
    query,
    scope,
    pendingAction,
    errorText,
    issuedToken,
    visibleDevices,
    selectedDevice: state?.selectedDevice ?? null,
    selectedDeviceId: state?.selectedDeviceId ?? selectedDeviceId,
    setQuery,
    setScope,
    setIssuedToken,
    writeRoute,
    loadState,
    createToken,
    revokeToken,
    updateDescription,
  };
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
