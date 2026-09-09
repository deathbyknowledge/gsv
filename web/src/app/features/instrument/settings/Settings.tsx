import { LoadingState } from "../../../components/ui/Spinner";
import { InstrumentHeader } from "../shared/InstrumentHeader";
import { useQuery } from "@tanstack/preact-query";
import { useCallback, useEffect, useLayoutEffect, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../gsv-console/backend/consoleService";
import { SettingsError } from "./settingsShared";
import { Preferences } from "./Preferences";
import { Permissions } from "./Permissions";
import { Instructions } from "./Instructions";
import { Integrations } from "./Integrations";
import "./settings.css";

export type SettingsProps = {
  onZen: () => void;
  onFleet: () => void;
  onMemory: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

const SECTIONS = ["preferences", "permissions", "instructions", "integrations"] as const;
type Section = typeof SECTIONS[number];

export function Settings({ onZen, onFleet, onMemory, onDirtyChange }: SettingsProps) {
  const { client, connected } = useGateway();
  const [section, setSection] = useState<Section>("preferences");
  const [dirty, setDirty] = useState<Record<Section, boolean>>({ preferences: false, permissions: false, instructions: false, integrations: false });
  const preferencesDirty = useCallback((value: boolean) => setDirty((old) => old.preferences === value ? old : { ...old, preferences: value }), []);
  const permissionsDirty = useCallback((value: boolean) => setDirty((old) => old.permissions === value ? old : { ...old, permissions: value }), []);
  const instructionsDirty = useCallback((value: boolean) => setDirty((old) => old.instructions === value ? old : { ...old, instructions: value }), []);
  const integrationsDirty = useCallback((value: boolean) => setDirty((old) => old.integrations === value ? old : { ...old, integrations: value }), []);
  const hasDrafts = Object.values(dirty).some(Boolean);
  useLayoutEffect(() => { onDirtyChange?.(hasDrafts); }, [hasDrafts, onDirtyChange]);
  useLayoutEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!hasDrafts) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDrafts]);
  const accounts = useQuery({ queryKey: ["accounts", "gsv-console"], queryFn: () => loadConsoleAccounts(client), enabled: connected });
  const account = accounts.data?.find((entry) => entry.relation === "self");
  return <main class="settings" aria-label="Settings">
    <InstrumentHeader status="settings">
      <button type="button" onClick={onZen}>zen</button>
      <button type="button" onClick={onFleet}><kbd>z</kbd>fleet</button>
      <button type="button" onClick={onMemory}><kbd>m</kbd>memory</button>
      <span aria-current="page">settings</span>
    </InstrumentHeader>
    <div class="settings-body">
      <nav class="settings-sections" aria-label="Settings sections">{SECTIONS.map((entry) => <button class={`ibtn${section === entry ? " active" : ""}`} aria-current={section === entry ? "page" : undefined} onClick={() => setSection(entry)} key={entry}>{entry}{dirty[entry] ? " ·" : ""}</button>)}</nav>
      <div class="settings-content">
        {!connected && <p class="settings-muted" role="status">Disconnected. Reconnect to load or save settings.</p>}
        <SettingsError error={accounts.error} />
        {accounts.isPending && connected && <LoadingState variant="panel">Loading your account…</LoadingState>}
        {accounts.data && !account && <p class="settings-error" role="alert">Your account could not be identified. Settings cannot be edited.</p>}
        {account && <div key={account.uid}>
          <div hidden={section !== "preferences"}><Preferences account={account} active={section === "preferences"} onDirty={preferencesDirty} /></div>
          <div hidden={section !== "permissions"}><Permissions account={account} active={section === "permissions"} onDirty={permissionsDirty} /></div>
          <div hidden={section !== "instructions"}><Instructions account={account} active={section === "instructions"} onDirty={instructionsDirty} /></div>
          <div hidden={section !== "integrations"}><Integrations account={account} active={section === "integrations"} onDirty={integrationsDirty} /></div>
        </div>}
      </div>
    </div>
  </main>;
}
