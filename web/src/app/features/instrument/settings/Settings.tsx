import { useSession } from "../../../services/session/SessionProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useCallback, useEffect, useLayoutEffect, useState } from "preact/hooks";
import { RetainedView, useViewActive } from "../../../services/navigation/ViewActivity";
import { navigateApp, useAppLocation } from "../../../services/navigation/appNavigation";
import { useNativeInput } from "../../../services/platform/PlatformProvider";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../../services/system/consoleService";
import { SettingsError } from "./settingsShared";
import { StandingResponsibilities } from "./StandingResponsibilities";
import { Preferences } from "./Preferences";
import { Permissions } from "./Permissions";
import { Instructions } from "./Instructions";
import { MessengerConnections } from "./MessengerConnections";
import { Mcp } from "./Mcp";
import { OwnerAccess, PersonalPasswordReset } from "./OwnerAccess";
import { Logs } from "./Logs";
import { DesktopVoiceSettings } from "./DesktopVoiceSettings";
import { rich, useT, type TextKey } from "../../../i18n/locale";
import "./settings.css";
import { PageHeading } from "../../../components/ui/PageHeading";

export type SettingsProps = {
  onDirtyChange?: (dirty: boolean) => void;
  onSignOut?: () => void;
  onInspectProcess: (pid: string) => void;
};

const SECTIONS = ["preferences", "voice", "standing", "permissions", "instructions", "messengers", "mcp", "logs", "account", "sign-in"] as const;
type Section = typeof SECTIONS[number];
const SECTION_LABELS = {
  preferences: "settings.section.preferences",
  account: "settings.account.title",
  voice: "settings.section.voice",
  standing: "settings.section.standing",
  permissions: "settings.section.permissions",
  instructions: "settings.section.instructions",
  messengers: "settings.section.messengers",
  mcp: "settings.section.mcp",
  logs: "settings.section.logs",
  "sign-in": "settings.section.signIn",
} satisfies Record<Section, TextKey>;

export function Settings({ onDirtyChange, onSignOut, onInspectProcess }: SettingsProps) {
  const t = useT();
  const active = useViewActive();
  const desktop = useNativeInput() !== null;
  const location = useAppLocation();
  const { client, connected } = useGateway();
  const { service: session } = useSession();
  const requestedSection = () => SECTIONS.find((entry) => entry === new URLSearchParams(window.location.search).get("section") && (entry !== "voice" || desktop)) ?? "preferences";
  const [section, setSection] = useState<Section>(requestedSection);
  useLayoutEffect(() => { if (active) setSection(requestedSection()); }, [active, location.revision, desktop]);
  const [dirty, setDirty] = useState<Record<Section, boolean>>({ preferences: false, voice: false, standing: false, permissions: false, instructions: false, messengers: false, mcp: false, logs: false, account: false, "sign-in": false });
  const preferencesDirty = useCallback((value: boolean) => setDirty((old) => old.preferences === value ? old : { ...old, preferences: value }), []);
  const permissionsDirty = useCallback((value: boolean) => setDirty((old) => old.permissions === value ? old : { ...old, permissions: value }), []);
  const instructionsDirty = useCallback((value: boolean) => setDirty((old) => old.instructions === value ? old : { ...old, instructions: value }), []);
  const mcpDirty = useCallback((value: boolean) => setDirty((old) => old.mcp === value ? old : { ...old, mcp: value }), []);
  const voiceDirty = useCallback((value: boolean) => setDirty((old) => old.voice === value ? old : { ...old, voice: value }), []);
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
  return <main class="settings" aria-label={t("settings.title")}>
    <div class="settings-body">
      <nav class="settings-sections" aria-label={t("settings.sections")} data-scroll-edge>{SECTIONS.filter((entry) => (entry !== "sign-in" || account?.uid === 0) && (entry !== "voice" || desktop)).map((entry) => <button class="ibtn" aria-current={section === entry ? "page" : undefined} onClick={() => navigateApp(`/chat/settings?section=${entry}`)} key={entry}>{t(SECTION_LABELS[entry])}{dirty[entry] ? " ·" : ""}</button>)}</nav>
      <div class="settings-content" data-scroll-edge>
        <div class="settings-account"><span>{account?.username ?? t("settings.yourSession")}</span><button class="settings-text-action" type="button" onClick={() => {
          if (onSignOut) { onSignOut(); return; }
          if (hasDrafts && !window.confirm(t("settings.confirmSignOut"))) return;
          void session.lock("session.status.signedOut");
        }}>{t("settings.signOut")}</button></div>
        {desktop && <RetainedView active={active && section === "voice"}><DesktopVoiceSettings active={active && section === "voice"} onDirty={voiceDirty} /></RetainedView>}
        {section !== "voice" && <>
          {!connected && <p class="settings-muted" role="status">{t("settings.disconnected")}</p>}
          <SettingsError error={accounts.error} />
          {accounts.isPending && connected && <LoadingState variant="panel">{t("settings.loadingAccount")}</LoadingState>}
          {accounts.data && !account && <p class="settings-error" role="alert">{t("settings.accountUnknown")}</p>}
        </>}
        {account && <div key={account.uid}>
          <div hidden={section !== "preferences"}><Preferences account={account} active={active && section === "preferences"} onDirty={preferencesDirty} /></div>
          <RetainedView active={active && section === "standing"}><StandingResponsibilities account={account} /></RetainedView>
          <div hidden={section !== "permissions"}><Permissions account={account} active={active && section === "permissions"} onDirty={permissionsDirty} /></div>
          <div hidden={section !== "instructions"}><Instructions account={account} active={active && section === "instructions"} onDirty={instructionsDirty} /></div>
          <div hidden={section !== "messengers"}><MessengerConnections account={account} active={active && section === "messengers"} /></div>
          <div hidden={section !== "mcp"}><Mcp account={account} active={active && section === "mcp"} onDirty={mcpDirty} /></div>
          <RetainedView active={active && section === "logs"}><Logs account={account} onProcess={onInspectProcess} /></RetainedView>
          <section hidden={section !== "account"} aria-labelledby="settings-account-title">
            <PageHeading id="settings-account-title" title={t("settings.account.title")} description={t("settings.account.intro")} />
            <h2>{t("settings.account.deleteTitle")}</h2>
            <p class="settings-intro">{rich(t("settings.account.deleteRequest"), { email: <a href="mailto:privacy@humansandmachin.es">privacy@humansandmachin.es</a> })}</p>
            <p class="settings-muted">{t("settings.account.deleteExplanation")}</p>
          </section>
          {account.uid === 0 && <div hidden={section !== "sign-in"}><PageHeading title={t("settings.signIn.title")} description={t("settings.signIn.intro")} /><PersonalPasswordReset active={active && section === "sign-in"} /><OwnerAccess /></div>}
        </div>}
      </div>
    </div>
  </main>;
}
