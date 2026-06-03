import { useEffect, useMemo, useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import {
  AI_FIELDS,
  buildUserAiOverrideKey,
} from "./config-schema";
import {
  buildDrafts,
  isWideField,
  serializeConfigValue,
  settingFieldsForRuntime,
  summarizeValue,
  unmodeledEntries,
} from "./settings-domain";
import type {
  AdministrationState,
  ConfigEntry,
  SaveConfigEntry,
  SettingField,
  SettingsPanelId,
} from "./types";

export function SettingsView({
  state,
  pendingAction,
  onSave,
  onClientError,
}: {
  state: AdministrationState;
  pendingAction: string | null;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
  onClientError: (message: string | null) => void;
}) {
  const [panel, setPanel] = useState<SettingsPanelId>("ai");
  const initialDrafts = useMemo(() => buildDrafts(state.configValues), [state.configValues]);
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);

  useEffect(() => {
    setDrafts(initialDrafts);
  }, [initialDrafts]);

  function updateDraft(key: string, value: string): void {
    setDrafts((current) => ({ ...current, [key]: value }));
  }

  function resetKeys(keys: string[]): void {
    setDrafts((current) => {
      const next = { ...current };
      for (const key of keys) {
        if (initialDrafts[key] !== undefined) {
          next[key] = initialDrafts[key];
        } else {
          delete next[key];
        }
      }
      return next;
    });
  }

  async function saveEntries(actionId: string, entries: SaveConfigEntry[]): Promise<void> {
    await onSave(actionId, entries.map((entry) => ({
      key: entry.key,
      value: serializeConfigValue(entry.key, entry.value),
    })));
  }

  return (
    <section class="gsv-admin-settings">
      <aside class="gsv-admin-nav" aria-label="Settings sections">
        {([
          ["ai", "AI", "Provider, model, keys, and personal overrides"],
          ["runtime", "Runtime", "Shell defaults and server settings"],
          ["advanced", "Advanced", "Raw config for recovery and unmodeled keys"],
        ] as Array<[SettingsPanelId, string, string]>).map(([id, label, description]) => (
          <button key={id} type="button" class={panel === id ? "is-active" : ""} onClick={() => setPanel(id)}>
            <strong>{label}</strong>
            <span>{description}</span>
          </button>
        ))}
      </aside>

      {panel === "ai" ? (
        <SettingsForm
          title="AI defaults"
          description="Root edits system defaults. Non-root users save personal AI overrides."
          fields={AI_FIELDS}
          values={state.configValues}
          viewer={state.viewer}
          drafts={drafts}
          initialDrafts={initialDrafts}
          pendingAction={pendingAction}
          overrideAiForUser={!state.viewer.canEditSystemConfig}
          onChange={updateDraft}
          onReset={resetKeys}
          onSave={saveEntries}
        />
      ) : panel === "runtime" ? (
        <SettingsForm
          title="Runtime behavior"
          description="Shell defaults and runtime metadata. Root access is required to change these settings."
          fields={settingFieldsForRuntime()}
          values={state.configValues}
          viewer={state.viewer}
          drafts={drafts}
          initialDrafts={initialDrafts}
          pendingAction={pendingAction}
          overrideAiForUser={false}
          onChange={updateDraft}
          onReset={resetKeys}
          onSave={saveEntries}
        />
      ) : (
        <AdvancedConfig
          entries={state.configEntries}
          viewer={state.viewer}
          pendingAction={pendingAction}
          onSave={saveEntries}
          onClientError={onClientError}
        />
      )}
    </section>
  );
}

function SettingsForm({
  title,
  description,
  fields,
  values,
  viewer,
  drafts,
  initialDrafts,
  pendingAction,
  overrideAiForUser,
  onChange,
  onReset,
  onSave,
}: {
  title: string;
  description: string;
  fields: SettingField[];
  values: Record<string, string>;
  viewer: AdministrationState["viewer"];
  drafts: Record<string, string>;
  initialDrafts: Record<string, string>;
  pendingAction: string | null;
  overrideAiForUser: boolean;
  onChange: (key: string, value: string) => void;
  onReset: (keys: string[]) => void;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
}) {
  const rows = fields.map((field) => {
    const editableKey = overrideAiForUser ? buildUserAiOverrideKey(viewer.uid, field.key) : field.key;
    const systemValue = initialDrafts[field.key] ?? "";
    const fallback = overrideAiForUser ? systemValue : initialDrafts[editableKey] ?? systemValue;
    const value = drafts[editableKey] ?? initialDrafts[editableKey] ?? fallback;
    const baseline = initialDrafts[editableKey] ?? fallback;
    const disabled = (!viewer.canEditSystemConfig && !overrideAiForUser) || field.kind === "readonly";
    const hasOverride = overrideAiForUser && values[editableKey] !== undefined;
    const note = overrideAiForUser
      ? (hasOverride ? "Personal override active." : `Using system default: ${summarizeValue(systemValue)}`)
      : !viewer.canEditSystemConfig && field.kind !== "readonly"
        ? "Only root can edit this system setting."
        : null;
    return { field, editableKey, value, baseline, disabled, note, dirty: value !== baseline };
  });
  const editableRows = rows.filter((row) => !row.disabled && row.field.kind !== "readonly");
  const dirty = editableRows.some((row) => row.dirty);
  const actionId = `save:${title}`;

  return (
    <section class="gsv-admin-panel">
      <header class="gsv-admin-panel-head">
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </header>
      <div class="gsv-admin-settings-grid">
        {rows.map((row) => (
          <SettingBlock key={row.editableKey} row={row} onChange={onChange} />
        ))}
      </div>
      {editableRows.length > 0 ? (
        <div class="gsv-admin-actions">
          <span>{dirty ? "Unsaved changes" : "No changes"}</span>
          <ActionButton icon="refresh" label="Reset" disabled={!dirty || pendingAction === actionId} onClick={() => onReset(editableRows.map((row) => row.editableKey))} />
          <ActionButton icon="check" label="Save changes" busyLabel="Saving" busy={pendingAction === actionId} disabled={!dirty} onClick={() => void onSave(actionId, editableRows.map((row) => ({ key: row.editableKey, value: row.value })))} />
        </div>
      ) : null}
    </section>
  );
}

function AdvancedConfig({
  entries,
  viewer,
  pendingAction,
  onSave,
  onClientError,
}: {
  entries: ConfigEntry[];
  viewer: AdministrationState["viewer"];
  pendingAction: string | null;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
  onClientError: (message: string | null) => void;
}) {
  const editableEntries = useMemo(
    () => viewer.canEditSystemConfig ? entries : entries.filter((entry) => entry.key.startsWith(viewer.userAiPrefix)),
    [entries, viewer],
  );
  const initialDraft = useMemo(
    () => JSON.stringify(Object.fromEntries(editableEntries.map((entry) => [entry.key, entry.value])), null, 2),
    [editableEntries],
  );
  const [draft, setDraft] = useState(initialDraft);
  const extraEntries = unmodeledEntries(entries);

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  function apply(): void {
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      const nextEntries = Object.entries(parsed).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
      }));
      if (!viewer.canEditSystemConfig) {
        const invalid = nextEntries.find((entry) => !entry.key.startsWith(viewer.userAiPrefix));
        if (invalid) {
          throw new Error(`Only ${viewer.userAiPrefix}* keys are editable for ${viewer.username}`);
        }
      }
      onClientError(null);
      void onSave("save:advanced", nextEntries);
    } catch (error) {
      onClientError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section class="gsv-admin-panel">
      <header class="gsv-admin-panel-head">
        <div>
          <h4>{viewer.canEditSystemConfig ? "Advanced config" : "Advanced personal overrides"}</h4>
          <p>{viewer.canEditSystemConfig ? "Raw config editing for unmodeled keys, recovery, and debugging." : `Raw personal AI overrides under ${viewer.userAiPrefix}*.`}</p>
        </div>
      </header>
      {extraEntries.length > 0 ? (
        <p class="gsv-admin-note">{extraEntries.length} visible key{extraEntries.length === 1 ? "" : "s"} are not modeled by the curated settings panels.</p>
      ) : null}
      <textarea class="gsv-admin-raw" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} />
      <div class="gsv-admin-actions">
        <ActionButton icon="check" label="Apply raw updates" busyLabel="Applying" busy={pendingAction === "save:advanced"} onClick={apply} />
        <ActionButton icon="refresh" label="Reset" disabled={pendingAction === "save:advanced"} onClick={() => setDraft(initialDraft)} />
      </div>
    </section>
  );
}

type SettingRow = {
  field: SettingField;
  editableKey: string;
  value: string;
  disabled: boolean;
  note: string | null;
};

function SettingBlock({ row, onChange }: { row: SettingRow; onChange: (key: string, value: string) => void }) {
  return (
    <div class={`gsv-admin-setting${isWideField(row.field) ? " is-wide" : ""}`}>
      <label>{row.field.label}</label>
      <p>{row.field.description}</p>
      <SettingInput row={row} onChange={(value) => onChange(row.editableKey, value)} />
      {row.note ? <span class="gsv-admin-field-note">{row.note}</span> : null}
    </div>
  );
}

function SettingInput({ row, onChange }: { row: SettingRow; onChange: (value: string) => void }) {
  const field = row.field;
  if (field.kind === "textarea" || field.kind === "json") {
    return <textarea rows={field.rows ?? 6} value={row.value} disabled={row.disabled} placeholder={field.placeholder} onInput={(event) => onChange(event.currentTarget.value)} />;
  }
  if (field.kind === "select") {
    return (
      <select value={row.value} disabled={row.disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  if (field.kind === "checkbox") {
    return (
      <label class="gsv-admin-toggle">
        <input type="checkbox" checked={row.value === "true"} disabled={row.disabled} onInput={(event) => onChange(event.currentTarget.checked ? "true" : "false")} />
        <span>{row.value === "true" ? "Enabled" : "Disabled"}</span>
      </label>
    );
  }
  if (field.kind === "readonly") {
    return <div class="gsv-admin-readonly">{row.value || "not set"}</div>;
  }
  return <input type={field.kind === "number" ? "number" : field.kind === "password" ? "password" : "text"} value={row.value} disabled={row.disabled} placeholder={field.placeholder} onInput={(event) => onChange(event.currentTarget.value)} />;
}
