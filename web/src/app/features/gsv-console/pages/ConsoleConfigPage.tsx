import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  AgentToolsPanel,
  type AgentToolApprovalPolicy,
  type AgentToolTarget,
} from "../../../components/ui/AgentToolsPanel";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Select, type SelectOption } from "../../../components/ui/Select";
import { Surface } from "../../../components/ui/Surface";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import { aiProviderOptionsForValue } from "../../../domain/aiProviders";
import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import { useUnsavedGuard, useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  SettingsListPanel,
  type SettingsListRow,
} from "../components/SettingsListPanel";
import type { SaveConsoleConfigInput } from "../backend/consoleService";
import type {
  ConsoleAccount,
  ConsoleConfigEntry,
  ConsoleTarget,
} from "../domain/consoleModels";
import {
  GLOBAL_APPROVAL_CONFIG_KEY,
  parseApprovalPolicy,
  serializeApprovalPolicy,
} from "../domain/consoleAgentBehavior";
import {
  AGENT_MODEL_FIELDS,
  MODEL_PROFILE_FIELDS,
  MODEL_PROFILE_SECRET_FIELDS,
  RUNTIME_SETTING_GROUPS,
  TOOL_MODEL_GROUPS,
  buildUserAiOverrideKey,
  configEntryForKey,
  configValueForKey,
  createModelProfile,
  deleteModelProfile,
  effectiveAiValuesForViewer,
  isSensitiveSettingKey,
  modelDisplayName,
  modelValidationValuesFromProfileDrafts,
  modelProfileSecretConfigKey,
  modelProfileSummary,
  modelProfilesConfigKey,
  modelProfilesForConfig,
  profileValuesFromDrafts,
  serializeModelProfiles,
  updateModelProfile,
  viewerAccountForSettings,
  type ConsoleModelProfile,
  type ConsoleSettingField,
  type ConsoleSettingGroup,
} from "../domain/consoleSettings";
import {
  useConsoleAccounts,
  useConsoleConfig,
  useConsoleTargets,
  useSaveConsoleConfigEntries,
  useValidateConsoleModelConfig,
} from "../hooks/useConsoleData";
import "./ConsoleConfigPage.css";

export type ConsoleConfigKind = "models" | "overrides";

/** The open config detail, reported up so the shell can render the breadcrumb
 *  trail (SETTINGS → MODELS → [detail]) and route the back-arrow. `onExit` runs
 *  the same guarded back as the detail's own controls. */
export type ConsoleConfigDetail = { label: string; onExit: () => void };

type ConsoleConfigPageProps = {
  kind: ConsoleConfigKind;
  /** Optional model selection to open immediately (e.g. "default" deep-links to
   *  the Default Agent Model detail page). */
  select?: string;
  /** Clears the deep-link `select` from the settings route/URL — called when a
   *  `select`-opened detail navigates back, so the URL doesn't stay pinned to
   *  the detail (which would reopen it on reload). */
  onClearSelect?: () => void;
  /** Reports the open detail (or null on the list) so the breadcrumb owns the
   *  path back — replaces the in-page back button. */
  onDetailChange?: (detail: ConsoleConfigDetail | null) => void;
};

function modelSelectionFromParam(select: string | undefined): ModelSelection | null {
  return select === "default" ? { kind: "default" } : null;
}

type SettingsViewer = {
  account: ConsoleAccount | null;
  uid: number | null;
  isRoot: boolean;
};

type ModelSelection =
  | { kind: "default" }
  | { kind: "new-profile" }
  | { kind: "profile"; id: string }
  | { kind: "tool"; id: string };

type RuntimeSelection = {
  id: string;
};

type ValidateModelSettingsInput = {
  values: Record<string, string>;
  presetId?: string;
};

type SettingsStatusTone = "pending" | "success" | "error";

type SettingsFieldGroupProps = {
  config: readonly ConsoleConfigEntry[];
  description: string;
  editable: boolean;
  fields: readonly ConsoleSettingField[];
  initialValues?: Record<string, string>;
  meta?: string;
  modelProfiles?: readonly ConsoleModelProfile[];
  onSave: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>;
  targets?: readonly AgentToolTarget[];
  title: string;
  validateBeforeSave?: (values: Record<string, string>) => Promise<void>;
  writeKeyForField: (field: ConsoleSettingField) => string;
};

type ClearedProfileSecretKeys = ReadonlyMap<string, ReadonlySet<string>>;
const TOOL_APPROVAL_RUNTIME_ID = "tool-approval";
const MODEL_ADVANCED_FIELD_KEYS = new Set([
  "config/ai/base_url",
  "config/ai/fallback_model_profile",
  "config/ai/provider_style",
  "config/ai/transport_target",
  "config/ai/reasoning",
  "config/ai/max_tokens",
  "config/ai/max_context_bytes",
]);
const MODEL_TRANSPORT_TARGET_KEY = "config/ai/transport_target";
const GSV_TRANSPORT_TARGET_OPTION: SelectOption = {
  label: "GSV Worker",
  value: "gsv",
  description: "Send HTTP from the gateway Worker runtime.",
};

export function ConsoleConfigPage({ kind, select, onClearSelect, onDetailChange }: ConsoleConfigPageProps) {
  const config = useConsoleConfig();
  const accounts = useConsoleAccounts();
  const targets = useConsoleTargets();

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={{ ...config.resource, isEmpty: false }}
        emptyLabel={kind === "models" ? "NO MODEL SETTINGS" : "NO RUNTIME SETTINGS"}
        errorLabel={kind === "models" ? "MODELS" : "RUNTIME"}
        render={(data) => (
          <ConsoleSettingsPanel
            accounts={accounts.accounts}
            config={data}
            kind={kind}
            targets={toolTargetsForConsoleTargets(targets.targets)}
            select={select}
            onClearSelect={onClearSelect}
            onDetailChange={onDetailChange}
          />
        )}
      />
    </ConsolePage>
  );
}

function ConsoleSettingsPanel({
  accounts,
  config,
  kind,
  targets,
  select,
  onClearSelect,
  onDetailChange,
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  kind: ConsoleConfigKind;
  targets: readonly AgentToolTarget[];
  select?: string;
  onClearSelect?: () => void;
  onDetailChange?: (detail: ConsoleConfigDetail | null) => void;
}) {
  const viewerAccount = viewerAccountForSettings(accounts);
  const viewer: SettingsViewer = {
    account: viewerAccount,
    uid: viewerAccount?.uid ?? null,
    isRoot: viewerAccount?.uid === 0,
  };

  if (kind === "models") {
    return <ModelSettingsPage config={config} targets={targets} viewer={viewer} select={select} onClearSelect={onClearSelect} onDetailChange={onDetailChange} />;
  }
  return <RuntimeSettingsPage config={config} targets={targets} viewer={viewer} onDetailChange={onDetailChange} />;
}

function ModelSettingsPage({
  config,
  targets,
  viewer,
  select,
  onClearSelect,
  onDetailChange,
}: {
  config: readonly ConsoleConfigEntry[];
  targets: readonly AgentToolTarget[];
  viewer: SettingsViewer;
  select?: string;
  onClearSelect?: () => void;
  onDetailChange?: (detail: ConsoleConfigDetail | null) => void;
}) {
  const saveConfig = useSaveConsoleConfigEntries();
  const validateModelConfig = useValidateConsoleModelConfig();
  const requestLeave = useUnsavedGuardLeave();
  const [selection, setSelection] = useState<ModelSelection | null>(() => modelSelectionFromParam(select));
  // The state is seeded once above, but this component stays mounted across
  // settings-route changes, so browser back/forward (or any external route
  // update) that changes `select` must be reflected here — otherwise the URL and
  // the shown detail desync. `select` only ever encodes the "default" detail;
  // locally-opened profile/tool details keep it undefined, so the effect only
  // fires on default deep-link/clear and never clobbers a local selection.
  useEffect(() => {
    setSelection(modelSelectionFromParam(select));
  }, [select]);
  const effectiveValues = useMemo(
    () => effectiveAiValuesForViewer(config, viewer.uid),
    [config, viewer.uid],
  );
  const profiles = useMemo(
    () => modelProfilesForConfig(config, viewer.uid),
    [config, viewer.uid],
  );
  const canEditAi = viewer.uid !== null;
  const scopeLabel = viewer.isRoot ? "GLOBAL" : viewer.account ? "PERSONAL" : "READ ONLY";

  const saveEntries = async (entries: readonly SaveConsoleConfigInput[]) => {
    if (entries.length === 0) {
      return;
    }
    await saveConfig.mutateAsync({ entries });
  };
  const validateModelSettings = async (input: ValidateModelSettingsInput) => {
    await validateModelConfig.mutateAsync(input);
  };

  // Leave the open detail and return to the list. A detail opened via the
  // `select` deep-link still has it pinned in the settings route/URL, so clear
  // that too — otherwise back leaves the list rendered at the detail URL and a
  // reload reopens it.
  const exitDetail = () => {
    setSelection(null);
    if (select) {
      onClearSelect?.();
    }
  };

  // Report the open detail to the shell so the breadcrumb shows the trail and
  // owns the path back (no in-page back button). The label mirrors the detail's
  // own title.
  const detailLabel = !selection
    ? null
    : selection.kind === "default"
    ? "DEFAULT AGENT MODEL"
    : selection.kind === "new-profile"
    ? "NEW MODEL PRESET"
    : selection.kind === "tool"
    ? (TOOL_MODEL_GROUPS.find((group) => group.id === selection.id)?.title ?? "TOOL MODEL").toUpperCase()
    : (profiles.find((profile) => profile.id === selection.id)?.name ?? "MODEL PRESET").toUpperCase();
  useEffect(() => {
    onDetailChange?.(detailLabel ? { label: detailLabel, onExit: () => requestLeave(exitDetail) } : null);
  }, [detailLabel]);
  useEffect(() => () => onDetailChange?.(null), []);

  if (selection) {
    return (
      <ModelSettingsDetail
        config={config}
        editable={canEditAi}
        effectiveValues={effectiveValues}
        profiles={profiles}
        scopeLabel={scopeLabel}
        selection={selection}
        targets={targets}
        viewer={viewer}
        // User-initiated Back/Cancel: guard so a dirty draft prompts first.
        onBack={() => requestLeave(exitDetail)}
        // Successful create/delete: the draft is saved, so return directly
        // without a spurious "Discard changes?" prompt.
        onCompleted={exitDetail}
        onSaveEntries={saveEntries}
        onValidateModelConfig={validateModelSettings}
      />
    );
  }

  return (
    <section class="gsv-console-settings-index">
      <SectionHeader title="MODELS" headingLevel={2} divider />
      <SettingsListPanel
        title="DEFAULT AGENT MODEL"
        meta={scopeLabel}
        emptyLabel="NO DEFAULT MODEL"
        fitContent
        headingLevel={3}
        rows={[defaultModelRow(effectiveValues, () => setSelection({ kind: "default" }))]}
      />
      <SettingsListPanel
        title="MODEL PRESETS"
        meta={`${profiles.length} PRESET${profiles.length === 1 ? "" : "S"}`}
        emptyLabel="NO MODEL PRESETS"
        fitContent
        headingLevel={3}
        action={{ label: "NEW MODEL PRESET", onClick: canEditAi ? () => setSelection({ kind: "new-profile" }) : undefined }}
        rows={profiles.map((profile) => profileRow(profile, () => setSelection({ kind: "profile", id: profile.id })))}
      />
      <SettingsListPanel
        title="TOOL MODELS"
        meta={`${TOOL_MODEL_GROUPS.length} STACKS`}
        emptyLabel="NO TOOL MODELS"
        fitContent
        headingLevel={3}
        rows={TOOL_MODEL_GROUPS.map((group) => toolModelRow(group, effectiveValues, () => setSelection({ kind: "tool", id: group.id })))}
      />
    </section>
  );
}

function ModelSettingsDetail({
  config,
  editable,
  effectiveValues,
  profiles,
  scopeLabel,
  selection,
  targets,
  viewer,
  onBack,
  onCompleted,
  onSaveEntries,
  onValidateModelConfig,
}: {
  config: readonly ConsoleConfigEntry[];
  editable: boolean;
  effectiveValues: Record<string, string>;
  profiles: readonly ConsoleModelProfile[];
  scopeLabel: string;
  selection: ModelSelection;
  targets: readonly AgentToolTarget[];
  viewer: SettingsViewer;
  /** Guarded user-initiated Back/Cancel. */
  onBack: () => void;
  /** Unguarded return after a successful create/delete (draft already saved). */
  onCompleted: () => void;
  onSaveEntries: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>;
  onValidateModelConfig: (input: ValidateModelSettingsInput) => Promise<void>;
}) {
  if (selection.kind === "default") {
    return (
      <ConsoleDetailPage
        icon="stars"
        title="DEFAULT AGENT MODEL"
        typeLabel="GSV · MODELS"
        statusLabel={scopeLabel}
        tone={editable ? "online" : "idle"}
        blurb="Fallback model stack used when an agent inherits model behavior."
        parentLabel="MODELS"
        onBack={onBack}
      >
        <SettingsFieldGroup
          config={config}
          description={viewer.isRoot
            ? "Global fallback used by agents without personal model overrides."
            : "Your personal fallback used when your agents inherit model behavior."}
          editable={editable}
          fields={AGENT_MODEL_FIELDS}
          initialValues={effectiveValues}
          meta={scopeLabel}
          modelProfiles={profiles}
          targets={targets}
          title="Default Agent Model"
          validateBeforeSave={(values) => onValidateModelConfig({ values })}
          writeKeyForField={(field) => viewer.isRoot || viewer.uid === null
            ? field.key
            : buildUserAiOverrideKey(viewer.uid, field.key)}
          onSave={onSaveEntries}
        />
      </ConsoleDetailPage>
    );
  }

  if (selection.kind === "tool") {
    const group = TOOL_MODEL_GROUPS.find((candidate) => candidate.id === selection.id) ?? TOOL_MODEL_GROUPS[0];
    return (
      <ConsoleDetailPage
        icon={toolModelIcon(group.id)}
        title={group.title.toUpperCase()}
        typeLabel="GSV · TOOL MODEL"
        statusLabel={scopeLabel}
        tone={editable ? "online" : "idle"}
        blurb={group.description}
        parentLabel="MODELS"
        onBack={onBack}
      >
        <SettingsFieldGroup
          config={config}
          description={group.description}
          editable={editable}
          fields={group.fields}
          initialValues={effectiveValues}
          meta={viewer.isRoot ? "GLOBAL STACK" : "PERSONAL OVERRIDE"}
          title={group.title}
          writeKeyForField={(field) => viewer.isRoot || viewer.uid === null
            ? field.key
            : buildUserAiOverrideKey(viewer.uid, field.key)}
          onSave={onSaveEntries}
        />
      </ConsoleDetailPage>
    );
  }

  const profile = selection.kind === "profile"
    ? profiles.find((candidate) => candidate.id === selection.id) ?? null
    : null;
  const title = profile?.name.toUpperCase() ?? "NEW MODEL PRESET";

  return (
    <ConsoleDetailPage
      icon="stars"
      title={title}
      typeLabel="GSV · MODEL PRESET"
      statusLabel={profile ? "SAVED" : "DRAFT"}
      tone={profile ? "online" : "idle"}
      blurb="Reusable named model stack for agents, including provider credentials when a preset needs its own key."
      parentLabel="MODELS"
      onBack={onBack}
    >
      <ModelProfileForm
        config={config}
        defaultValues={effectiveValues}
        editable={editable}
        profile={profile}
        profiles={profiles}
        targets={targets}
        viewer={viewer}
        onCancel={onBack}
        onDelete={profile ? async () => {
          await saveModelProfiles(viewer, profiles, deleteModelProfile(profiles, profile.id), onSaveEntries);
          onCompleted();
        } : undefined}
        onMakeDefault={profile ? async (values) => {
          await makeProfileDefault(config, viewer, { ...profile, values }, onSaveEntries);
        } : undefined}
        onValidate={onValidateModelConfig}
        onSave={async (name, values, clearedSecretKeys) => {
          const nextProfiles = profile
            ? updateModelProfile(profiles, profile.id, name, values)
            : createModelProfile(profiles, name, values);
          await saveModelProfiles(viewer, profiles, nextProfiles, onSaveEntries, clearedSecretKeys);
          if (!profile) {
            onCompleted();
          }
        }}
      />
    </ConsoleDetailPage>
  );
}

function RuntimeSettingsPage({
  config,
  targets,
  viewer,
  onDetailChange,
}: {
  config: readonly ConsoleConfigEntry[];
  targets: readonly AgentToolTarget[];
  viewer: SettingsViewer;
  onDetailChange?: (detail: ConsoleConfigDetail | null) => void;
}) {
  const saveConfig = useSaveConsoleConfigEntries();
  const requestLeave = useUnsavedGuardLeave();
  const [selection, setSelection] = useState<RuntimeSelection | null>(null);
  const canEditRuntime = viewer.isRoot;

  // Report the open detail so the breadcrumb owns the path back (no in-page
  // back button) — same trail as the model config: SETTINGS → RUNTIME → [detail].
  const detailLabel = selection
    ? runtimeSelectionTitle(selection.id)
    : null;
  useEffect(() => {
    onDetailChange?.(detailLabel ? { label: detailLabel, onExit: () => requestLeave(() => setSelection(null)) } : null);
  }, [detailLabel]);
  useEffect(() => () => onDetailChange?.(null), []);

  const saveEntries = async (entries: readonly SaveConsoleConfigInput[]) => {
    if (entries.length === 0) {
      return;
    }
    await saveConfig.mutateAsync({ entries });
  };

  if (selection) {
    if (selection.id === TOOL_APPROVAL_RUNTIME_ID) {
      return (
        <ConsoleDetailPage
          icon="cog"
          title="TOOL APPROVAL"
          typeLabel="GSV · RUNTIME"
          statusLabel={canEditRuntime ? "SYSTEM FALLBACK" : "ROOT REQUIRED"}
          tone={canEditRuntime ? "online" : "idle"}
          blurb="Fallback tool approval policy used when neither a user nor an agent defines one."
          parentLabel="RUNTIME"
          onBack={() => requestLeave(() => setSelection(null))}
        >
          <ToolApprovalSettingsGroup
            config={config}
            editable={canEditRuntime}
            targets={targets}
            onSave={saveEntries}
          />
        </ConsoleDetailPage>
      );
    }

    const group = RUNTIME_SETTING_GROUPS.find((candidate) => candidate.id === selection.id) ?? RUNTIME_SETTING_GROUPS[0];
    return (
      <ConsoleDetailPage
        icon={group.id === "shell" ? "terminal" : "cog"}
        title={group.title.toUpperCase()}
        typeLabel="GSV · RUNTIME"
        statusLabel={canEditRuntime ? "GLOBAL SETTINGS" : "ROOT REQUIRED"}
        tone={canEditRuntime ? "online" : "idle"}
        blurb={group.description}
        parentLabel="RUNTIME"
        onBack={() => requestLeave(() => setSelection(null))}
      >
        <SettingsFieldGroup
          config={config}
          description={group.description}
          editable={canEditRuntime}
          fields={group.fields}
          meta={canEditRuntime ? "EDITABLE" : "READ ONLY"}
          title={group.title}
          writeKeyForField={(field) => field.key}
          onSave={saveEntries}
        />
      </ConsoleDetailPage>
    );
  }

  return (
    <section class="gsv-console-settings-index">
      <SectionHeader title="RUNTIME" headingLevel={2} divider />
      <SettingsListPanel
        title="TOOL APPROVAL"
        meta={canEditRuntime ? "SYSTEM FALLBACK" : "ROOT REQUIRED"}
        emptyLabel="NO TOOL APPROVAL SETTINGS"
        fitContent
        headingLevel={3}
        rows={[toolApprovalRuntimeRow(config, () => setSelection({ id: TOOL_APPROVAL_RUNTIME_ID }))]}
      />
      {RUNTIME_SETTING_GROUPS.map((group) => (
        <SettingsListPanel
          key={group.id}
          title={group.title.toUpperCase()}
          meta={canEditRuntime ? "EDITABLE" : "ROOT REQUIRED"}
          emptyLabel={`NO ${group.title.toUpperCase()} SETTINGS`}
          fitContent
          headingLevel={3}
          rows={[runtimeGroupRow(group, config, () => setSelection({ id: group.id }))]}
        />
      ))}
    </section>
  );
}

function runtimeSelectionTitle(selectionId: string): string {
  if (selectionId === TOOL_APPROVAL_RUNTIME_ID) {
    return "TOOL APPROVAL";
  }
  return (RUNTIME_SETTING_GROUPS.find((group) => group.id === selectionId)?.title ?? "RUNTIME").toUpperCase();
}

function defaultModelRow(values: Record<string, string>, onOpen: () => void): SettingsListRow {
  const model = values["config/ai/model"] ?? "";
  const label = modelDisplayName(model) || "Not configured";
  return {
    id: "default-agent-model",
    icon: "stars",
    label,
    sub: model || "Default agent model stack",
    statusLabel: model ? "DEFAULT" : "EMPTY",
    tone: model ? "online" : "idle",
    onOpen,
  };
}

function profileRow(profile: ConsoleModelProfile, onOpen: () => void): SettingsListRow {
  const model = profile.values["config/ai/model"] ?? "";
  return {
    id: profile.id,
    icon: "stars",
    label: profile.name,
    sub: modelDisplayName(model) || model || "Model behavior preset",
    statusLabel: model ? "PRESET" : "INCOMPLETE",
    tone: model ? "online" : "warn",
    tag: { label: modelDisplayName(model) || "MODEL", tone: "info" },
    onOpen,
  };
}

function toolModelRow(
  group: ConsoleSettingGroup,
  values: Record<string, string>,
  onOpen: () => void,
): SettingsListRow {
  const modelField = group.fields.find((field) => field.key.endsWith("/model"));
  const model = modelField ? values[modelField.key] ?? "" : "";
  return {
    id: group.id,
    icon: toolModelIcon(group.id),
    label: group.title,
    sub: model ? modelDisplayName(model) : group.description,
    statusLabel: model ? "CONFIGURED" : "EMPTY",
    tone: model ? "online" : "idle",
    onOpen,
  };
}

function toolModelIcon(groupId: string): string {
  switch (groupId) {
    case "image-generation":
      return "doticons/pencil";
    case "image-read":
      return "doticons/camera";
    case "speech":
      return "doticons/volume";
    case "transcription":
      return "doticons/microphone";
    default:
      return "cog";
  }
}

function toolApprovalRuntimeRow(
  config: readonly ConsoleConfigEntry[],
  onOpen: () => void,
): SettingsListRow {
  const policy = parseApprovalPolicy(configValueForKey(config, GLOBAL_APPROVAL_CONFIG_KEY));
  const rules = policy.rules.length;
  return {
    id: TOOL_APPROVAL_RUNTIME_ID,
    icon: "cog",
    label: "Tool approval fallback",
    sub: `${approvalActionLabel(policy.default)} · ${rules} override${rules === 1 ? "" : "s"}`,
    statusLabel: "FALLBACK",
    tone: "online",
    onOpen,
  };
}

function approvalActionLabel(action: AgentToolApprovalPolicy["default"]): string {
  if (action === "auto") return "Allow automatically";
  if (action === "deny") return "Deny by default";
  return "Ask first";
}

function runtimeGroupRow(
  group: ConsoleSettingGroup,
  config: readonly ConsoleConfigEntry[],
  onOpen: () => void,
): SettingsListRow {
  const values = group.fields.map((field) => configValueForKey(config, field.key)).filter((value) => value.trim().length > 0);
  const primary = group.id === "shell"
    ? shellRuntimeSummary(config)
    : serverRuntimeSummary(config);
  return {
    id: group.id,
    icon: group.id === "shell" ? "terminal" : "cog",
    label: group.title,
    sub: primary,
    statusLabel: `${values.length} SET`,
    tone: values.length > 0 ? "online" : "idle",
    onOpen,
  };
}

function shellRuntimeSummary(config: readonly ConsoleConfigEntry[]): string {
  const timeout = configValueForKey(config, "config/shell/timeout_ms") || "timeout";
  const network = configValueForKey(config, "config/shell/network_enabled") === "true" ? "network on" : "network off";
  const output = configValueForKey(config, "config/shell/max_output_bytes") || "output cap";
  return `${timeout} ms · ${network} · ${output} bytes`;
}

function serverRuntimeSummary(config: readonly ConsoleConfigEntry[]): string {
  const name = configValueForKey(config, "config/server/name") || "gsv";
  const timezone = configValueForKey(config, "config/server/timezone") || "UTC";
  const version = configValueForKey(config, "config/server/version") || "version";
  return `${name} · ${timezone} · ${version}`;
}

function toolTargetsForConsoleTargets(targets: readonly ConsoleTarget[]): AgentToolTarget[] {
  return targets.map((target) => ({
    id: target.deviceId,
    label: target.label || target.deviceId,
    online: target.online,
    implements: target.implements,
  }));
}

function ToolApprovalSettingsGroup({
  config,
  editable,
  targets,
  onSave,
}: {
  config: readonly ConsoleConfigEntry[];
  editable: boolean;
  targets: readonly AgentToolTarget[];
  onSave: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>;
}) {
  const rawPolicy = configValueForKey(config, GLOBAL_APPROVAL_CONFIG_KEY);
  const initialPolicy = useMemo<AgentToolApprovalPolicy>(
    () => parseApprovalPolicy(rawPolicy),
    [rawPolicy],
  );
  const initialSignature = serializeApprovalPolicy(initialPolicy);
  const [policy, setPolicy] = useState<AgentToolApprovalPolicy>(initialPolicy);
  const [pending, setPending] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [statusTone, setStatusTone] = useState<SettingsStatusTone>("success");

  useEffect(() => {
    setPolicy(initialPolicy);
    setStatusText("");
    setStatusTone("success");
    setPending(false);
  }, [initialSignature]);

  const draftSignature = serializeApprovalPolicy(policy);
  const dirty = draftSignature !== initialSignature;
  useUnsavedGuard(() => dirty);

  const save = async () => {
    if (!dirty || pending) {
      return;
    }
    setPending(true);
    setStatusText("");
    setStatusTone("pending");
    try {
      await onSave([{ key: GLOBAL_APPROVAL_CONFIG_KEY, value: draftSignature }]);
      setStatusTone("success");
      setStatusText("Saved");
    } catch (error) {
      setStatusTone("error");
      setStatusText(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Surface level={1} class="gsv-console-settings-group gsv-console-tool-approval-settings">
      <AgentToolsPanel
        policy={policy}
        sourceLabel="System fallback"
        sourceDescription="Used only when neither a user default nor an agent override is configured."
        targets={targets}
        disabled={!editable || pending}
        onChange={(nextPolicy) => {
          setPolicy(nextPolicy);
          setStatusText("");
        }}
      />
      <SettingsStatus text={statusText} tone={statusTone} />
      <div class="gsv-console-settings-actions">
        <Button
          variant="primary"
          label={pending ? "SAVING" : "SAVE CHANGES"}
          disabled={!editable || !dirty || pending}
          onClick={() => void save()}
        />
        <Button
          variant="secondary"
          label="RESET"
          disabled={!dirty || pending}
          onClick={() => {
            setPolicy(initialPolicy);
            setStatusText("");
          }}
        />
      </div>
    </Surface>
  );
}

async function saveModelProfiles(
  viewer: SettingsViewer,
  currentProfiles: readonly ConsoleModelProfile[],
  nextProfiles: readonly ConsoleModelProfile[],
  onSaveEntries: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>,
  clearedSecretKeys: ClearedProfileSecretKeys = new Map(),
): Promise<void> {
  if (viewer.uid === null) {
    throw new Error("A signed-in account is required to save model presets.");
  }
  const nextIds = new Set(nextProfiles.map((profile) => profile.id));
  const entries: SaveConsoleConfigInput[] = [{
    key: modelProfilesConfigKey(viewer.uid),
    value: serializeModelProfiles(nextProfiles),
  }];
  for (const profile of nextProfiles) {
    const clearedForProfile = clearedSecretKeys.get(profile.id);
    for (const field of MODEL_PROFILE_SECRET_FIELDS) {
      const value = profile.values[field.key] ?? "";
      if (clearedForProfile?.has(field.key)) {
        entries.push({
          key: modelProfileSecretConfigKey(viewer.uid, profile.id, field.key),
          value: "",
        });
      } else if (value.length > 0) {
        entries.push({
          key: modelProfileSecretConfigKey(viewer.uid, profile.id, field.key),
          value,
        });
      }
    }
  }
  for (const profile of currentProfiles) {
    if (nextIds.has(profile.id)) {
      continue;
    }
    for (const field of MODEL_PROFILE_SECRET_FIELDS) {
      entries.push({
        key: modelProfileSecretConfigKey(viewer.uid, profile.id, field.key),
        value: "",
      });
    }
  }
  await onSaveEntries(entries);
}

async function makeProfileDefault(
  config: readonly ConsoleConfigEntry[],
  viewer: SettingsViewer,
  profile: ConsoleModelProfile,
  onSaveEntries: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>,
): Promise<void> {
  if (viewer.uid === null) {
    throw new Error("A signed-in account is required to update the default model.");
  }
  await onSaveEntries(MODEL_PROFILE_FIELDS.flatMap((field): SaveConsoleConfigInput[] => {
    const key = viewer.isRoot ? field.key : buildUserAiOverrideKey(viewer.uid!, field.key);
    const value = profile.values[field.key] ?? "";
    if (isSensitiveSettingKey(field.key) && value.length === 0) {
      const copyFromKey = modelProfileSecretConfigKey(viewer.uid!, profile.id, field.key);
      if (configEntryForKey(config, copyFromKey)?.redacted === true) {
        return [{ key, copyFromKey }];
      }
      return [];
    }
    return [{
      key,
      value,
    }];
  }));
}

function ModelProfileForm({
  config,
  defaultValues,
  editable,
  profile,
  profiles,
  targets,
  viewer,
  onCancel,
  onDelete,
  onMakeDefault,
  onValidate,
  onSave,
}: {
  config: readonly ConsoleConfigEntry[];
  defaultValues: Record<string, string>;
  editable: boolean;
  profile: ConsoleModelProfile | null;
  profiles: readonly ConsoleModelProfile[];
  targets: readonly AgentToolTarget[];
  viewer: SettingsViewer;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  onMakeDefault?: (values: Record<string, string>) => Promise<void>;
  onValidate: (input: ValidateModelSettingsInput) => Promise<void>;
  onSave: (
    name: string,
    values: Record<string, string>,
    clearedSecretKeys: ClearedProfileSecretKeys,
  ) => Promise<void>;
}) {
  const initialValues = useMemo(
    () => profile ? profile.values : profileValuesFromDrafts(defaultValues),
    [defaultValues, profile],
  );
  const [name, setName] = useState(profile?.name ?? "");
  const [drafts, setDrafts] = useState(initialValues);
  const [clearedSecretKeys, setClearedSecretKeys] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [statusText, setStatusText] = useState("");
  const [statusTone, setStatusTone] = useState<SettingsStatusTone>("success");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(profile?.name ?? "");
    setDrafts(initialValues);
    setClearedSecretKeys(new Set());
    setPendingLabel("");
    setStatusText("");
    setStatusTone("success");
    setConfirmDelete(false);
  }, [initialValues, profile]);

  const duplicateName = profiles.some((candidate) =>
    candidate.id !== profile?.id &&
    candidate.name.toLowerCase() === name.trim().toLowerCase()
  );
  const canSave = editable && name.trim().length > 0 && !duplicateName && drafts["config/ai/model"]?.trim();
  const clearedProfileSecretKeys = profile
    ? new Map([[profile.id, clearedSecretKeys]])
    : new Map<string, ReadonlySet<string>>();

  const dirty = name !== (profile?.name ?? "") ||
    clearedSecretKeys.size > 0 ||
    JSON.stringify(drafts) !== JSON.stringify(initialValues);
  useUnsavedGuard(() => dirty);

  const run = async (action: () => Promise<void>, successText: string, label = "SAVING") => {
    setPending(true);
    setPendingLabel(label);
    setStatusText("");
    setStatusTone("pending");
    try {
      await action();
      setStatusTone("success");
      setStatusText(successText);
    } catch (error) {
      setStatusTone("error");
      setStatusText(errorMessage(error));
    } finally {
      setPendingLabel("");
      setPending(false);
    }
  };
  const validateDrafts = async () => {
    const validationValues = modelValidationValuesFromProfileDrafts(drafts, clearedSecretKeys);
    setPendingLabel("TESTING");
    setStatusTone("pending");
    setStatusText("Testing model...");
    await onValidate({
      values: validationValues,
      ...(profile && !clearedSecretKeys.has("config/ai/api_key") ? { presetId: profile.id } : {}),
    });
  };
  const profileFields = splitModelSettingsFields(MODEL_PROFILE_FIELDS);
  const advancedResetKey = `${profile?.id ?? "new"}:${JSON.stringify(initialValues)}`;
  const renderProfileField = (field: ConsoleSettingField) => (
    <div
      class={`gsv-console-settings-field${field.half ? " is-half" : ""}`}
      key={field.key}
    >
      <SettingFieldInput
        field={field}
        disabled={!editable || pending}
        modelProfiles={profiles}
        excludeModelProfileId={profile?.id}
        targets={targets}
        cleared={clearedSecretKeys.has(field.key)}
        redacted={isModelProfileFieldRedacted(config, viewer, profile, field)}
        value={drafts[field.key] ?? ""}
        onChange={(value) => {
          setClearedSecretKeys((current) => {
            if (!current.has(field.key)) {
              return current;
            }
            const next = new Set(current);
            next.delete(field.key);
            return next;
          });
          setDrafts((current) => ({ ...current, [field.key]: value }));
          setStatusText("");
        }}
        onClearRedacted={() => {
          setClearedSecretKeys((current) => new Set(current).add(field.key));
          setDrafts((current) => ({ ...current, [field.key]: "" }));
          setStatusText("");
        }}
      />
    </div>
  );

  return (
    <>
      <Surface level={1} class="gsv-console-model-form">
        <div class="gsv-console-settings-fields">
          <div class="gsv-console-settings-field">
            <TextInput
              label="PRESET NAME"
              placeholder="Deep Research"
              value={name}
              disabled={!editable || pending}
              status={duplicateName ? "error" : "none"}
              message={duplicateName ? "NAME ALREADY EXISTS" : ""}
              onChange={setName}
            />
          </div>
          {profileFields.primary.map(renderProfileField)}
        </div>
        {profileFields.advanced.length > 0 ? (
          <AdvancedSettingsFields
            initialOpen={shouldOpenModelAdvancedFields(initialValues)}
            resetKey={advancedResetKey}
          >
            {profileFields.advanced.map(renderProfileField)}
          </AdvancedSettingsFields>
        ) : null}
        <SettingsStatus text={statusText} tone={statusTone} />
        <div class="gsv-console-settings-actions">
          <Button
            variant="primary"
            label={pending ? pendingLabel || "SAVING" : "TEST & SAVE PRESET"}
            disabled={!canSave || pending}
            onClick={() => void run(async () => {
              await validateDrafts();
              setPendingLabel("SAVING");
              setStatusText("Model test passed. Saving preset...");
              await onSave(name, drafts, clearedProfileSecretKeys);
            }, "Saved", "TESTING")}
          />
          {profile && onMakeDefault ? (
            <Button
              variant="secondary"
              label="TEST & MAKE DEFAULT"
              disabled={!editable || pending}
              onClick={() => void run(async () => {
                await validateDrafts();
                setPendingLabel("UPDATING");
                setStatusText("Model test passed. Updating default...");
                await onMakeDefault(drafts);
              }, "Default updated", "TESTING")}
            />
          ) : null}
          <Button variant="secondary" label="CANCEL" disabled={pending} onClick={onCancel} />
          {profile && onDelete ? (
            <Button
              variant="dangerGhost"
              label="DELETE"
              disabled={!editable || pending}
              onClick={() => setConfirmDelete(true)}
            />
          ) : null}
        </div>
      </Surface>
      {profile && onDelete && confirmDelete ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmDelete(false)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="CONFIRM DELETE"
              message={`Delete model preset "${profile.name}"?`}
              note="The preset is removed and stored secret fields for this preset are cleared."
              confirmLabel="DELETE PRESET"
              confirmPhrase={profile.name}
              confirmInputPlaceholder={profile.name}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => {
                setConfirmDelete(false);
                void run(onDelete, "Deleted", "DELETING");
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function SettingsFieldGroup({
  config,
  editable,
  fields,
  initialValues,
  modelProfiles = [],
  onSave,
  targets = [],
  validateBeforeSave,
  writeKeyForField,
}: SettingsFieldGroupProps) {
  const initialDraftEntries = fields.map((field): [string, string] => [
    field.key,
    initialValues?.[field.key] ?? configValueForKey(config, field.key),
  ]);
  const initialDraftsSignature = JSON.stringify(initialDraftEntries);
  const initialDrafts = useMemo<Record<string, string>>(
    () => Object.fromEntries(initialDraftEntries),
    [initialDraftsSignature],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const [clearedSensitiveKeys, setClearedSensitiveKeys] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [statusText, setStatusText] = useState("");
  const [statusTone, setStatusTone] = useState<SettingsStatusTone>("success");

  useEffect(() => {
    setDrafts(initialDrafts);
    setClearedSensitiveKeys(new Set());
    setPendingLabel("");
    setStatusText("");
    setStatusTone("success");
  }, [initialDrafts]);

  const changedEntries = fields.flatMap((field) => {
    if (field.kind === "readonly") {
      return [];
    }
    const value = drafts[field.key] ?? "";
    const baseline = initialDrafts[field.key] ?? "";
    if (isSensitiveSettingKey(field.key) && value.length === 0) {
      if (!clearedSensitiveKeys.has(field.key)) {
        return [];
      }
      return [{
        key: writeKeyForField(field),
        value: "",
      }];
    }
    if (value === baseline) {
      return [];
    }
    return [{
      key: writeKeyForField(field),
      value: serializeSettingValue(field, value),
    }];
  });
  const dirty = changedEntries.length > 0;
  useUnsavedGuard(() => dirty);
  const fieldGroups = splitModelSettingsFields(fields);
  const advancedResetKey = initialDraftsSignature;

  const save = async () => {
    if (!dirty || pending) {
      return;
    }
    setPending(true);
    setPendingLabel(validateBeforeSave ? "TESTING" : "SAVING");
    setStatusText("");
    setStatusTone("pending");
    try {
      if (validateBeforeSave) {
        const validationDrafts = { ...drafts };
        for (const field of fields) {
          if (
            isSensitiveSettingKey(field.key) &&
            validationDrafts[field.key] === "" &&
            !clearedSensitiveKeys.has(field.key)
          ) {
            delete validationDrafts[field.key];
          }
        }
        setStatusText("Testing model...");
        await validateBeforeSave(validationDrafts);
        setPendingLabel("SAVING");
        setStatusText("Model test passed. Saving settings...");
      }
      await onSave(changedEntries);
      setClearedSensitiveKeys(new Set());
      setStatusTone("success");
      setStatusText("Saved");
    } catch (error) {
      setStatusTone("error");
      setStatusText(errorMessage(error));
    } finally {
      setPendingLabel("");
      setPending(false);
    }
  };
  const renderSettingField = (field: ConsoleSettingField) => (
    <div
      class={`gsv-console-settings-field${field.half ? " is-half" : ""}`}
      key={field.key}
    >
      <SettingFieldInput
        disabled={!editable || pending || field.kind === "readonly"}
        field={field}
        modelProfiles={modelProfiles}
        targets={targets}
        cleared={clearedSensitiveKeys.has(field.key)}
        redacted={isFieldRedacted(config, field, writeKeyForField(field))}
        value={drafts[field.key] ?? ""}
        onChange={(value) => {
          setStatusText("");
          setClearedSensitiveKeys((current) => {
            if (!current.has(field.key)) {
              return current;
            }
            const next = new Set(current);
            next.delete(field.key);
            return next;
          });
          setDrafts((current) => ({ ...current, [field.key]: value }));
        }}
        onClearRedacted={() => {
          setClearedSensitiveKeys((current) => new Set(current).add(field.key));
          setDrafts((current) => ({ ...current, [field.key]: "" }));
          setStatusText("");
        }}
      />
    </div>
  );

  return (
    <Surface level={1} class="gsv-console-settings-group">
      <div class="gsv-console-settings-fields">
        {fieldGroups.primary.map(renderSettingField)}
      </div>
      {fieldGroups.advanced.length > 0 ? (
        <AdvancedSettingsFields
          initialOpen={shouldOpenModelAdvancedFields(initialDrafts)}
          resetKey={advancedResetKey}
        >
          {fieldGroups.advanced.map(renderSettingField)}
        </AdvancedSettingsFields>
      ) : null}
      <SettingsStatus text={statusText} tone={statusTone} />
      <div class="gsv-console-settings-actions">
        <Button
          variant="primary"
          label={pending ? pendingLabel || "SAVING" : validateBeforeSave ? "TEST & SAVE" : "SAVE CHANGES"}
          disabled={!editable || !dirty || pending}
          onClick={() => void save()}
        />
        <Button
          variant="secondary"
          label="RESET"
          disabled={!dirty || pending}
          onClick={() => {
            setDrafts(initialDrafts);
            setClearedSensitiveKeys(new Set());
            setStatusText("");
          }}
        />
      </div>
    </Surface>
  );
}

function AdvancedSettingsFields({
  children,
  initialOpen,
  resetKey,
}: {
  children: ComponentChildren;
  initialOpen: boolean;
  resetKey: string;
}) {
  const [open, setOpen] = useState(initialOpen);

  useEffect(() => {
    setOpen(initialOpen);
  }, [initialOpen, resetKey]);

  return (
    <details
      class="gsv-console-advanced-fields"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="gsv-console-advanced-summary">
        <span>Advanced</span>
        <span aria-hidden="true">{open ? "HIDE" : "SHOW"}</span>
      </summary>
      <div class="gsv-console-settings-fields gsv-console-advanced-fields-grid">
        {children}
      </div>
    </details>
  );
}

function splitModelSettingsFields(fields: readonly ConsoleSettingField[]): {
  primary: readonly ConsoleSettingField[];
  advanced: readonly ConsoleSettingField[];
} {
  const hasAdvancedModelFields = fields.some((field) => MODEL_ADVANCED_FIELD_KEYS.has(field.key));
  if (!hasAdvancedModelFields) {
    return { primary: fields, advanced: [] };
  }
  return {
    primary: fields.filter((field) => !MODEL_ADVANCED_FIELD_KEYS.has(field.key)),
    advanced: fields.filter((field) => MODEL_ADVANCED_FIELD_KEYS.has(field.key)),
  };
}

function shouldOpenModelAdvancedFields(values: Record<string, string>): boolean {
  const baseUrl = values["config/ai/base_url"]?.trim() ?? "";
  const fallbackModelProfile = values["config/ai/fallback_model_profile"]?.trim() ?? "";
  const providerStyle = values["config/ai/provider_style"]?.trim() ?? "";
  const transportTarget = values[MODEL_TRANSPORT_TARGET_KEY]?.trim() ?? "";
  return baseUrl.length > 0 ||
    fallbackModelProfile.length > 0 ||
    (providerStyle.length > 0 && providerStyle !== "auto") ||
    (transportTarget.length > 0 && transportTarget !== "gsv");
}

function SettingsStatus({
  text,
  tone,
}: {
  text: string;
  tone: SettingsStatusTone;
}) {
  return text ? (
    <div class={`gsv-console-settings-status gsv-sublabel is-${tone}`}>{text}</div>
  ) : null;
}

function SettingFieldInput({
  cleared = false,
  disabled,
  excludeModelProfileId,
  field,
  modelProfiles = [],
  redacted = false,
  targets = [],
  value,
  onChange,
  onClearRedacted,
}: {
  cleared?: boolean;
  disabled: boolean;
  excludeModelProfileId?: string;
  field: ConsoleSettingField;
  modelProfiles?: readonly ConsoleModelProfile[];
  redacted?: boolean;
  targets?: readonly AgentToolTarget[];
  value: string;
  onChange: (value: string) => void;
  onClearRedacted?: () => void;
}) {
  const [replacingRedacted, setReplacingRedacted] = useState(false);
  const placeholder = redacted ? "Enter replacement" : field.placeholder;
  const description = redacted ? `${field.description} Current value is hidden.` : field.description;

  useEffect(() => {
    if (!redacted) {
      setReplacingRedacted(false);
    }
  }, [redacted]);

  if (field.key === MODEL_TRANSPORT_TARGET_KEY) {
    const options = transportTargetOptionsForValue(value, targets);
    const selectedValue = normalizedTransportTargetValue(value);
    const selectedIndex = Math.max(0, options.findIndex((option) => selectOptionValue(option) === selectedValue));
    return (
      <Select
        label={field.label}
        description={description}
        options={options}
        value={selectedIndex}
        disabled={disabled}
        size={field.size}
        block
        onChange={(index) => onChange(selectOptionValue(options[index]) || "gsv")}
      />
    );
  }

  if (field.key === "config/ai/fallback_model_profile") {
    const options = fallbackModelProfileOptionsForValue(value, modelProfiles, excludeModelProfileId);
    const selectedValue = value.trim();
    const selectedIndex = Math.max(0, options.findIndex((option) => selectOptionValue(option) === selectedValue));
    return (
      <Select
        label={field.label}
        description={description}
        options={options}
        value={selectedIndex}
        disabled={disabled}
        size={field.size}
        block
        onChange={(index) => onChange(selectOptionValue(options[index]) || "")}
      />
    );
  }

  if (field.kind === "textarea") {
    return (
      <TextArea
        label={field.label}
        description={description}
        placeholder={placeholder}
        rows={field.rows ?? 4}
        size={field.size}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (field.kind === "select") {
    const options = field.key.endsWith("/provider") || field.key === "config/ai/provider"
      ? aiProviderOptionsForValue(value, field.options)
      : [...(field.options ?? [])];
    const optionLabels = options.map((option) => option.label);
    const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
    return (
      <Select
        label={field.label}
        description={description}
        options={optionLabels}
        value={selectedIndex}
        disabled={disabled}
        size={field.size}
        block
        onChange={(index) => onChange(options[index]?.value ?? "")}
      />
    );
  }

  if (field.kind === "checkbox") {
    return (
      <Checkbox
        label={field.label}
        description={description}
        checked={value === "true"}
        disabled={disabled}
        onChange={(checked) => onChange(checked ? "true" : "false")}
      />
    );
  }

  if (field.kind === "password" && redacted && !replacingRedacted) {
    return (
      <div class="gsv-console-secret-field">
        <div class="gsv-console-secret-label gsv-sublabel">{field.label}</div>
        <div class="gsv-console-secret-desc gsv-prose-sm">{description}</div>
        <div class={`gsv-console-secret-state${cleared ? " is-cleared" : ""}`}>
          <span>{cleared ? "WILL BE CLEARED" : "CONFIGURED"}</span>
          <small>{cleared ? "Save changes to remove this token." : "Stored value is hidden."}</small>
        </div>
        <div class="gsv-console-secret-actions">
          <Button
            variant="secondary"
            label="REPLACE"
            disabled={disabled}
            onClick={() => {
              onChange("");
              setReplacingRedacted(true);
            }}
          />
          {cleared ? (
            <Button
              variant="secondary"
              label="UNDO CLEAR"
              disabled={disabled}
              onClick={() => onChange("")}
            />
          ) : (
            <Button
              variant="dangerGhost"
              label="CLEAR"
              disabled={disabled || !onClearRedacted}
              onClick={onClearRedacted}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <TextInput
      label={field.label}
      description={description}
      placeholder={placeholder}
      size={field.size}
      value={value}
      readonly={field.kind === "readonly"}
      disabled={disabled}
      clearable={field.kind !== "readonly" && field.kind !== "password"}
      type={field.kind === "password" ? "password" : "text"}
      inputProps={field.kind === "number" ? { inputMode: "numeric" } : undefined}
      onChange={onChange}
    />
  );
}

function fallbackModelProfileOptionsForValue(
  value: string,
  profiles: readonly ConsoleModelProfile[],
  excludeProfileId?: string,
): SelectOption[] {
  const profileOptions = profiles
    .filter((profile) => profile.id !== excludeProfileId)
    .map((profile) => ({
      label: profile.name,
      value: profile.id,
      description: modelProfileSummary(profile.values),
    }));
  const options: SelectOption[] = [
    { label: "None", value: "" },
    ...profileOptions,
  ];
  const selectedValue = value.trim();
  if (!selectedValue || options.some((option) => selectOptionValue(option) === selectedValue)) {
    return options;
  }
  return [
    ...options,
    {
      label: selectedValue,
      value: selectedValue,
      description: "Stored fallback preset is not currently available.",
    },
  ];
}

function transportTargetOptionsForValue(
  value: string,
  targets: readonly AgentToolTarget[],
): SelectOption[] {
  const targetOptions: SelectOption[] = targets
    .filter((target) => target.id.trim().length > 0 && targetImplementsCapability(target, "net.fetch"))
    .slice()
    .sort((left, right) => {
      if (left.online !== right.online) {
        return left.online === false ? 1 : -1;
      }
      return (left.label || left.id).localeCompare(right.label || right.id);
    })
    .map((target) => {
      const label = target.label?.trim() || target.id;
      return {
        group: "Machines",
        label: target.online === false ? `${label} (offline)` : label,
        value: target.id,
        description: target.id,
      };
    });
  const options = [GSV_TRANSPORT_TARGET_OPTION, ...targetOptions];
  const selectedValue = normalizedTransportTargetValue(value);
  if (options.some((option) => selectOptionValue(option) === selectedValue)) {
    return options;
  }
  return [
    ...options,
    {
      group: "Stored target",
      label: selectedValue,
      value: selectedValue,
      description: "Stored target is not currently available with net.fetch.",
    },
  ];
}

function targetImplementsCapability(target: AgentToolTarget, capability: string): boolean {
  return (target.implements ?? []).some((pattern) => {
    if (pattern === "*" || pattern === capability) {
      return true;
    }
    if (pattern.endsWith(".*")) {
      return capability.startsWith(pattern.slice(0, -1));
    }
    return false;
  });
}

function normalizedTransportTargetValue(value: string): string {
  return value.trim() || "gsv";
}

function selectOptionValue(option: SelectOption | undefined): string {
  if (!option) {
    return "";
  }
  return typeof option === "string" ? option : option.value ?? option.label;
}

function isFieldRedacted(
  config: readonly ConsoleConfigEntry[],
  field: ConsoleSettingField,
  writeKey: string,
): boolean {
  if (!isSensitiveSettingKey(field.key) && !isSensitiveSettingKey(writeKey)) {
    return false;
  }
  const writeEntry = configEntryForKey(config, writeKey);
  const readEntry = configEntryForKey(config, field.key);
  return writeEntry?.redacted === true || readEntry?.redacted === true;
}

function isModelProfileFieldRedacted(
  config: readonly ConsoleConfigEntry[],
  viewer: SettingsViewer,
  profile: ConsoleModelProfile | null,
  field: ConsoleSettingField,
): boolean {
  if (!profile || viewer.uid === null || !isSensitiveSettingKey(field.key)) {
    return false;
  }
  const entry = configEntryForKey(config, modelProfileSecretConfigKey(viewer.uid, profile.id, field.key));
  return entry?.redacted === true;
}

function serializeSettingValue(field: ConsoleSettingField, value: string): string {
  if (field.kind === "number") {
    return value.trim();
  }
  if (field.kind === "checkbox") {
    return value === "true" ? "true" : "false";
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "Unable to save settings.";
}
