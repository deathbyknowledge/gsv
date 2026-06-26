import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { Select } from "../../../components/ui/Select";
import { Surface } from "../../../components/ui/Surface";
import { Tag } from "../../../components/ui/Tag";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
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
} from "../domain/consoleModels";
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
  useSaveConsoleConfigEntries,
} from "../hooks/useConsoleData";
import "./ConsoleConfigPage.css";

export type ConsoleConfigKind = "models" | "overrides";

type ConsoleConfigPageProps = {
  kind: ConsoleConfigKind;
};

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

type SettingsFieldGroupProps = {
  config: readonly ConsoleConfigEntry[];
  description: string;
  editable: boolean;
  fields: readonly ConsoleSettingField[];
  initialValues?: Record<string, string>;
  meta?: string;
  onSave: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>;
  title: string;
  writeKeyForField: (field: ConsoleSettingField) => string;
};

export function ConsoleConfigPage({ kind }: ConsoleConfigPageProps) {
  const config = useConsoleConfig();
  const accounts = useConsoleAccounts();

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
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  kind: ConsoleConfigKind;
}) {
  const viewerAccount = viewerAccountForSettings(accounts);
  const viewer: SettingsViewer = {
    account: viewerAccount,
    uid: viewerAccount?.uid ?? null,
    isRoot: viewerAccount?.uid === 0,
  };

  if (kind === "models") {
    return <ModelSettingsPage config={config} viewer={viewer} />;
  }
  return <RuntimeSettingsPage config={config} viewer={viewer} />;
}

function ModelSettingsPage({
  config,
  viewer,
}: {
  config: readonly ConsoleConfigEntry[];
  viewer: SettingsViewer;
}) {
  const saveConfig = useSaveConsoleConfigEntries();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
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

  if (selection) {
    return (
      <ModelSettingsDetail
        config={config}
        editable={canEditAi}
        effectiveValues={effectiveValues}
        profiles={profiles}
        scopeLabel={scopeLabel}
        selection={selection}
        viewer={viewer}
        onBack={() => setSelection(null)}
        onSaveEntries={saveEntries}
      />
    );
  }

  return (
    <section class="gsv-console-settings-index">
      <SettingsListPanel
        title="DEFAULT AGENT MODEL"
        meta={scopeLabel}
        emptyLabel="NO DEFAULT MODEL"
        fitContent
        rows={[defaultModelRow(effectiveValues, () => setSelection({ kind: "default" }))]}
      />
      <SettingsListPanel
        title="MODEL PRESETS"
        meta={`${profiles.length} PRESET${profiles.length === 1 ? "" : "S"}`}
        emptyLabel="NO MODEL PRESETS"
        fitContent
        action={{ label: "NEW MODEL PRESET", onClick: canEditAi ? () => setSelection({ kind: "new-profile" }) : undefined }}
        rows={profiles.map((profile) => profileRow(profile, () => setSelection({ kind: "profile", id: profile.id })))}
      />
      <SettingsListPanel
        title="TOOL MODELS"
        meta={`${TOOL_MODEL_GROUPS.length} STACKS`}
        emptyLabel="NO TOOL MODELS"
        fitContent
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
  viewer,
  onBack,
  onSaveEntries,
}: {
  config: readonly ConsoleConfigEntry[];
  editable: boolean;
  effectiveValues: Record<string, string>;
  profiles: readonly ConsoleModelProfile[];
  scopeLabel: string;
  selection: ModelSelection;
  viewer: SettingsViewer;
  onBack: () => void;
  onSaveEntries: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>;
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
          title="Default Agent Model"
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
        viewer={viewer}
        onCancel={onBack}
        onDelete={profile ? async () => {
          await saveModelProfiles(viewer, profiles, deleteModelProfile(profiles, profile.id), onSaveEntries);
          onBack();
        } : undefined}
        onMakeDefault={profile ? async (values) => {
          await makeProfileDefault(viewer, { ...profile, values }, onSaveEntries);
        } : undefined}
        onSave={async (name, values) => {
          const nextProfiles = profile
            ? updateModelProfile(profiles, profile.id, name, values)
            : createModelProfile(profiles, name, values);
          await saveModelProfiles(viewer, profiles, nextProfiles, onSaveEntries);
          if (!profile) {
            onBack();
          }
        }}
      />
    </ConsoleDetailPage>
  );
}

function RuntimeSettingsPage({
  config,
  viewer,
}: {
  config: readonly ConsoleConfigEntry[];
  viewer: SettingsViewer;
}) {
  const saveConfig = useSaveConsoleConfigEntries();
  const [selection, setSelection] = useState<RuntimeSelection | null>(null);
  const canEditRuntime = viewer.isRoot;

  const saveEntries = async (entries: readonly SaveConsoleConfigInput[]) => {
    if (entries.length === 0) {
      return;
    }
    await saveConfig.mutateAsync({ entries });
  };

  if (selection) {
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
        onBack={() => setSelection(null)}
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
      {RUNTIME_SETTING_GROUPS.map((group) => (
        <SettingsListPanel
          key={group.id}
          title={group.title.toUpperCase()}
          meta={canEditRuntime ? "EDITABLE" : "ROOT REQUIRED"}
          emptyLabel={`NO ${group.title.toUpperCase()} SETTINGS`}
          fitContent
          rows={[runtimeGroupRow(group, config, () => setSelection({ id: group.id }))]}
        />
      ))}
    </section>
  );
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

async function saveModelProfiles(
  viewer: SettingsViewer,
  currentProfiles: readonly ConsoleModelProfile[],
  nextProfiles: readonly ConsoleModelProfile[],
  onSaveEntries: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>,
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
    for (const field of MODEL_PROFILE_SECRET_FIELDS) {
      const value = profile.values[field.key] ?? "";
      if (value.length > 0) {
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
  viewer: SettingsViewer,
  profile: ConsoleModelProfile,
  onSaveEntries: (entries: readonly SaveConsoleConfigInput[]) => Promise<void>,
): Promise<void> {
  if (viewer.uid === null) {
    throw new Error("A signed-in account is required to update the default model.");
  }
  await onSaveEntries(MODEL_PROFILE_FIELDS.flatMap((field) => {
    const value = profile.values[field.key] ?? "";
    if (isSensitiveSettingKey(field.key) && value.length === 0) {
      return [];
    }
    return [{
      key: viewer.isRoot ? field.key : buildUserAiOverrideKey(viewer.uid!, field.key),
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
  viewer,
  onCancel,
  onDelete,
  onMakeDefault,
  onSave,
}: {
  config: readonly ConsoleConfigEntry[];
  defaultValues: Record<string, string>;
  editable: boolean;
  profile: ConsoleModelProfile | null;
  profiles: readonly ConsoleModelProfile[];
  viewer: SettingsViewer;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  onMakeDefault?: (values: Record<string, string>) => Promise<void>;
  onSave: (name: string, values: Record<string, string>) => Promise<void>;
}) {
  const initialValues = useMemo(
    () => profile ? profile.values : profileValuesFromDrafts(defaultValues),
    [defaultValues, profile],
  );
  const [name, setName] = useState(profile?.name ?? "");
  const [drafts, setDrafts] = useState(initialValues);
  const [pending, setPending] = useState(false);
  const [statusText, setStatusText] = useState("");

  useEffect(() => {
    setName(profile?.name ?? "");
    setDrafts(initialValues);
    setStatusText("");
  }, [initialValues, profile]);

  const duplicateName = profiles.some((candidate) =>
    candidate.id !== profile?.id &&
    candidate.name.toLowerCase() === name.trim().toLowerCase()
  );
  const canSave = editable && name.trim().length > 0 && !duplicateName && drafts["config/ai/model"]?.trim();

  const run = async (action: () => Promise<void>, successText: string) => {
    setPending(true);
    setStatusText("");
    try {
      await action();
      setStatusText(successText);
    } catch (error) {
      setStatusText(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Surface level={1} class="gsv-console-model-form">
      <div class="gsv-console-settings-form-head">
        <div>
          <h3>{profile ? "Edit Preset" : "New Preset"}</h3>
          <p>Presets store provider, model, API key, reasoning, and context limits.</p>
        </div>
      </div>
      <div class="gsv-console-settings-fields">
        <TextInput
          label="PRESET NAME"
          placeholder="Deep Research"
          value={name}
          disabled={!editable || pending}
          status={duplicateName ? "error" : "none"}
          message={duplicateName ? "NAME ALREADY EXISTS" : ""}
          onChange={setName}
        />
        {MODEL_PROFILE_FIELDS.map((field) => (
          <SettingFieldInput
            field={field}
            key={field.key}
            disabled={!editable || pending}
            redacted={isModelProfileFieldRedacted(config, viewer, profile, field)}
            value={drafts[field.key] ?? ""}
            onChange={(value) => setDrafts((current) => ({ ...current, [field.key]: value }))}
          />
        ))}
      </div>
      {statusText ? <div class="gsv-console-settings-status">{statusText}</div> : null}
      <div class="gsv-console-settings-actions">
        <Button
          variant="primary"
          label={pending ? "SAVING" : "SAVE PRESET"}
          disabled={!canSave || pending}
          onClick={() => void run(() => onSave(name, drafts), "Saved")}
        />
        {profile && onMakeDefault ? (
          <Button
            variant="secondary"
            label="MAKE DEFAULT"
            disabled={!editable || pending}
            onClick={() => void run(() => onMakeDefault(drafts), "Default updated")}
          />
        ) : null}
        <Button variant="secondary" label="CANCEL" disabled={pending} onClick={onCancel} />
        {profile && onDelete ? (
          <Button
            variant="dangerGhost"
            label="DELETE"
            disabled={!editable || pending}
            onClick={() => void run(onDelete, "Deleted")}
          />
        ) : null}
      </div>
    </Surface>
  );
}

function SettingsFieldGroup({
  config,
  description,
  editable,
  fields,
  initialValues,
  meta,
  onSave,
  title,
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
  const [pending, setPending] = useState(false);
  const [statusText, setStatusText] = useState("");

  useEffect(() => {
    setDrafts(initialDrafts);
    setStatusText("");
  }, [initialDrafts]);

  const changedEntries = fields.flatMap((field) => {
    if (field.kind === "readonly") {
      return [];
    }
    const value = drafts[field.key] ?? "";
    const baseline = initialDrafts[field.key] ?? "";
    if (isSensitiveSettingKey(field.key) && value.length === 0) {
      return [];
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

  const save = async () => {
    if (!dirty || pending) {
      return;
    }
    setPending(true);
    setStatusText("");
    try {
      await onSave(changedEntries);
      setStatusText("Saved");
    } catch (error) {
      setStatusText(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Surface level={1} class="gsv-console-settings-group">
      <div class="gsv-console-settings-form-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {meta ? <Tag label={meta} tone={editable ? "accent" : "idle"} boxed /> : null}
      </div>
      <div class="gsv-console-settings-fields">
        {fields.map((field) => (
          <SettingFieldInput
            disabled={!editable || pending || field.kind === "readonly"}
            field={field}
            key={field.key}
            redacted={isFieldRedacted(config, field, writeKeyForField(field))}
            value={drafts[field.key] ?? ""}
            onChange={(value) => {
              setStatusText("");
              setDrafts((current) => ({ ...current, [field.key]: value }));
            }}
          />
        ))}
      </div>
      {statusText ? <div class="gsv-console-settings-status">{statusText}</div> : null}
      <div class="gsv-console-settings-actions">
        <Button variant="primary" label={pending ? "SAVING" : "SAVE CHANGES"} disabled={!editable || !dirty || pending} onClick={() => void save()} />
        <Button
          variant="secondary"
          label="RESET"
          disabled={!dirty || pending}
          onClick={() => {
            setDrafts(initialDrafts);
            setStatusText("");
          }}
        />
      </div>
    </Surface>
  );
}

function SettingFieldInput({
  disabled,
  field,
  redacted = false,
  value,
  onChange,
}: {
  disabled: boolean;
  field: ConsoleSettingField;
  redacted?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const placeholder = redacted ? "configured - enter replacement" : field.placeholder;
  const description = redacted ? `${field.description} Current value is hidden.` : field.description;

  if (field.kind === "textarea") {
    return (
      <TextArea
        label={field.label}
        description={description}
        placeholder={placeholder}
        rows={field.rows ?? 4}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (field.kind === "select") {
    const options = field.options ?? [];
    const optionLabels = options.map((option) => option.label);
    const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
    return (
      <Select
        label={field.label}
        description={description}
        options={optionLabels}
        value={selectedIndex}
        disabled={disabled}
        width={420}
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

  return (
    <TextInput
      label={field.label}
      description={description}
      placeholder={placeholder}
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
  return writeEntry?.redacted === true || readEntry?.redacted === true || field.kind === "password";
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
