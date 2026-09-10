import { useSession } from "../../../services/session/SessionProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { useQuery } from "@tanstack/preact-query";
import { useCallback, useEffect, useLayoutEffect, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../gsv-console/backend/consoleService";
import { SettingsError } from "./settingsShared";
import { Preferences } from "./Preferences";
import { Permissions } from "./Permissions";
import { Instructions } from "./Instructions";
import { MessengerConnections } from "./MessengerConnections";
import { Mcp } from "./Mcp";
import "./settings.css";

export type SettingsProps = {
  onDirtyChange?: (dirty: boolean) => void;
};

const SECTIONS = ["preferences", "permissions", "instructions", "messengers", "mcp"] as const;
type Section = typeof SECTIONS[number];

export function Settings({ onDirtyChange }: SettingsProps) {
  const { client, connected } = useGateway();
  const { service: session } = useSession();
  const [section, setSection] = useState<Section>("preferences");
  const [dirty, setDirty] = useState<Record<Section, boolean>>({ preferences: false, permissions: false, instructions: false, messengers: false, mcp: false });
  const preferencesDirty = useCallback((value: boolean) => setDirty((old) => old.preferences === value ? old : { ...old, preferences: value }), []);
  const permissionsDirty = useCallback((value: boolean) => setDirty((old) => old.permissions === value ? old : { ...old, permissions: value }), []);
  const instructionsDirty = useCallback((value: boolean) => setDirty((old) => old.instructions === value ? old : { ...old, instructions: value }), []);
  const mcpDirty = useCallback((value: boolean) => setDirty((old) => old.mcp === value ? old : { ...old, mcp: value }), []);
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
    <div class="settings-body">
      <nav class="settings-sections" aria-label="Settings sections">{SECTIONS.map((entry) => <button class={`ibtn${section === entry ? " active" : ""}`} aria-current={section === entry ? "page" : undefined} onClick={() => setSection(entry)} key={entry}>{entry}{dirty[entry] ? " ·" : ""}</button>)}</nav>
      <div class="settings-content">
        <div class="settings-account"><span>{account?.username ?? "Your session"}</span><button class="settings-text-action" type="button" onClick={() => {
          if (hasDrafts && !window.confirm("Discard your unsaved settings changes and sign out?")) return;
          session.lock("Signed out");
        }}>sign out</button></div>
        {!connected && <p class="settings-muted" role="status">Disconnected. Reconnect to load or save settings.</p>}
        <SettingsError error={accounts.error} />
        {accounts.isPending && connected && <LoadingState variant="panel">Loading your account…</LoadingState>}
        {accounts.data && !account && <p class="settings-error" role="alert">Your account could not be identified. Settings cannot be edited.</p>}
        {account && <div key={account.uid}>
          <div hidden={section !== "preferences"}><Preferences account={account} active={section === "preferences"} onDirty={preferencesDirty} /></div>
          <div hidden={section !== "permissions"}><Permissions account={account} active={section === "permissions"} onDirty={permissionsDirty} /></div>
          <div hidden={section !== "instructions"}><Instructions account={account} active={section === "instructions"} onDirty={instructionsDirty} /></div>
          <div hidden={section !== "messengers"}><MessengerConnections account={account} active={section === "messengers"} /></div>
          <div hidden={section !== "mcp"}><Mcp account={account} active={section === "mcp"} onDirty={mcpDirty} /></div>
        </div>}
      </div>
    </div>
  </main>;
}
