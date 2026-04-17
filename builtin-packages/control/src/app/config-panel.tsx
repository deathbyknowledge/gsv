import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  AI_FIELDS,
  AUTOMATION_FIELDS,
  buildProfileApprovalKey,
  buildProfileContextKey,
  buildUserAiOverrideKey,
  CONFIG_SECTIONS,
  PROCESS_FIELDS,
  PROFILE_CONTEXT_FIELDS,
  PROFILE_OPTIONS,
  SERVER_FIELDS,
  SHELL_FIELDS,
  type ControlProfileId,
  type ControlSettingField,
} from "./config-schema";
import type { ControlConfigEntry, ControlConfigSectionId, ControlViewer } from "./types";

type SaveEntry = {
  key: string;
  value: string;
};

type ConfigPanelProps = {
  entries: ControlConfigEntry[];
  values: Record<string, string>;
  viewer: ControlViewer;
  pendingSection: string | null;
  activeSection: ControlConfigSectionId;
  onSelectSection: (section: ControlConfigSectionId) => void;
  onSaveEntries: (saveId: string, entries: SaveEntry[]) => Promise<void>;
};

type ResolvedField = {
  field: ControlSettingField;
  editableKey: string;
  value: string;
  baseline: string;
  dirty: boolean;
  disabled: boolean;
  note: string | null;
};

const SECTION_FIELDS: Record<Exclude<ControlConfigSectionId, "profiles">, ControlSettingField[]> = {
  ai: AI_FIELDS,
  shell: SHELL_FIELDS,
  server: SERVER_FIELDS,
  processes: PROCESS_FIELDS,
  automation: AUTOMATION_FIELDS,
};

export function ConfigPanel({
  entries,
  values,
  viewer,
  pendingSection,
  activeSection,
  onSelectSection,
  onSaveEntries,
}: ConfigPanelProps) {
  const [selectedProfile, setSelectedProfile] = useState<ControlProfileId>("task");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const initialDrafts = useMemo(() => buildDrafts(values), [values]);

  useEffect(() => {
    setDrafts(initialDrafts);
  }, [initialDrafts]);

  const uncategorizedEntries = useMemo(() => {
    const modeledKeys = new Set<string>([
      ...AI_FIELDS,
      ...SHELL_FIELDS,
      ...SERVER_FIELDS,
      ...PROCESS_FIELDS,
      ...AUTOMATION_FIELDS,
    ].map((field) => field.key));
    for (const profile of PROFILE_OPTIONS) {
      for (const contextField of PROFILE_CONTEXT_FIELDS) {
        modeledKeys.add(buildProfileContextKey(profile.id, contextField.file));
      }
      modeledKeys.add(buildProfileApprovalKey(profile.id));
    }
    return entries.filter((entry) => !modeledKeys.has(entry.key));
  }, [entries]);

  const profileRows = useMemo(() => {
    const rows = PROFILE_CONTEXT_FIELDS.map((field) => ({
      label: field.label,
      description: field.description,
      rows: field.rows,
      systemKey: buildProfileContextKey(selectedProfile, field.file),
    }));
    rows.push({
      label: "Tool approval policy",
      description: "Ordered approval rules for the selected profile. Stored as JSON with a default action and a rules array.",
      rows: 10,
      systemKey: buildProfileApprovalKey(selectedProfile),
    });
    return rows;
  }, [selectedProfile]);

  function editableKeyFor(systemKey: string): string {
    if (viewer.canEditSystemConfig) {
      return systemKey;
    }
    return buildUserAiOverrideKey(viewer.uid, systemKey);
  }

  function systemValueFor(systemKey: string): string {
    return initialDrafts[systemKey] ?? "";
  }

  function currentValueFor(editableKey: string, fallback: string): string {
    if (drafts[editableKey] !== undefined) {
      return drafts[editableKey];
    }
    if (initialDrafts[editableKey] !== undefined) {
      return initialDrafts[editableKey];
    }
    return fallback;
  }

  function baselineValueFor(editableKey: string, fallback: string): string {
    if (initialDrafts[editableKey] !== undefined) {
      return initialDrafts[editableKey];
    }
    return fallback;
  }

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

  async function saveKeys(saveId: string, payload: SaveEntry[]): Promise<void> {
    await onSaveEntries(saveId, payload.map((entry) => ({
      key: entry.key,
      value: serializeValue(entry.key, entry.value),
    })));
  }

  const profileResolvedRows = profileRows.map((row) => {
    const editableKey = editableKeyFor(row.systemKey);
    const systemValue = systemValueFor(row.systemKey);
    const value = currentValueFor(editableKey, systemValue);
    const baseline = baselineValueFor(editableKey, systemValue);
    const hasOverride = !viewer.canEditSystemConfig && values[editableKey] !== undefined;
    return {
      ...row,
      editableKey,
      value,
      baseline,
      dirty: value !== baseline,
      disabled: false,
      note: viewer.canEditSystemConfig ? null : buildOverrideNote(systemValue, hasOverride),
    };
  });
  const profileDirty = profileResolvedRows.some((row) => row.dirty);
  const profileSaveId = `profiles:${selectedProfile}`;

  return (
    <div class="control-config-stage">
      <aside class="control-config-rail">
        <div class="control-config-rail-head">
          <h2>Settings</h2>
          <p>Curated system settings and profile-level prompt policy.</p>
        </div>
        <nav class="control-config-nav" aria-label="Control config sections">
          {CONFIG_SECTIONS.map((section) => (
            <button
              key={section.id}
              class={`control-config-nav-item${section.id === activeSection ? " is-active" : ""}`}
              onClick={() => onSelectSection(section.id)}
            >
              <strong>{section.label}</strong>
              <small>{section.description}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section class="control-config-detail">
        {activeSection === "profiles" ? (
          <div class="control-detail-pane">
            <header class="control-detail-head">
              <div>
                <h2>Profiles</h2>
                <p>Edit the prompt context and approval policy that shape each runtime profile.</p>
              </div>
            </header>

            <div class="control-profile-picker" role="tablist" aria-label="Profile selector">
              {PROFILE_OPTIONS.map((profile) => (
                <button
                  key={profile.id}
                  class={`control-profile-pill${profile.id === selectedProfile ? " is-active" : ""}`}
                  onClick={() => setSelectedProfile(profile.id)}
                >
                  <strong>{profile.label}</strong>
                  <small>{profile.description}</small>
                </button>
              ))}
            </div>

            <div class="control-editor-stack">
              {profileResolvedRows.map((row) => (
                <EditorRow
                  key={row.systemKey}
                  label={row.label}
                  description={row.description}
                  rows={row.rows}
                  value={row.value}
                  disabled={row.disabled}
                  note={row.note}
                  onChange={(nextValue) => updateDraft(row.editableKey, nextValue)}
                />
              ))}
            </div>

            <div class="control-section-actions">
              <span class="control-inline-note">{profileDirty ? "Unsaved changes" : "No changes"}</span>
              <div class="control-section-actions-group">
                <button
                  class="control-button"
                  disabled={!profileDirty || pendingSection === profileSaveId}
                  onClick={() => resetKeys(profileResolvedRows.map((row) => row.editableKey))}
                >
                  Reset
                </button>
                <button
                  class="control-button control-button--primary"
                  disabled={!profileDirty || pendingSection === profileSaveId}
                  onClick={() => void saveKeys(profileSaveId, profileResolvedRows.map((row) => ({
                    key: row.editableKey,
                    value: row.value,
                  })))}
                >
                  {pendingSection === profileSaveId ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {activeSection !== "profiles" ? (
          <SectionForm
            sectionId={activeSection}
            fields={SECTION_FIELDS[activeSection]}
            values={values}
            viewer={viewer}
            drafts={drafts}
            initialDrafts={initialDrafts}
            pendingSection={pendingSection}
            onChange={updateDraft}
            onReset={resetKeys}
            onSave={saveKeys}
            extraNote={activeSection === "automation" ? (
              <div class="control-advanced-note">
                <h3>Not shown here</h3>
                <p>
                  Additional keys remain in <strong>Advanced</strong>, including package repo flags,
                  per-user overrides, and any config namespaces we have not explicitly designed yet.
                </p>
                {uncategorizedEntries.length > 0 ? (
                  <ul>
                    {uncategorizedEntries.slice(0, 8).map((entry) => (
                      <li key={entry.key}><code>{entry.key}</code></li>
                    ))}
                    {uncategorizedEntries.length > 8 ? <li>…and {uncategorizedEntries.length - 8} more</li> : null}
                  </ul>
                ) : null}
              </div>
            ) : null}
          />
        ) : null}
      </section>
    </div>
  );
}

type SectionFormProps = {
  sectionId: Exclude<ControlConfigSectionId, "profiles">;
  fields: ControlSettingField[];
  values: Record<string, string>;
  viewer: ControlViewer;
  drafts: Record<string, string>;
  initialDrafts: Record<string, string>;
  pendingSection: string | null;
  onChange: (key: string, value: string) => void;
  onReset: (keys: string[]) => void;
  onSave: (saveId: string, entries: SaveEntry[]) => Promise<void>;
  extraNote?: ComponentChildren;
};

function SectionForm({
  sectionId,
  fields,
  values,
  viewer,
  drafts,
  initialDrafts,
  pendingSection,
  onChange,
  onReset,
  onSave,
  extraNote,
}: SectionFormProps) {
  const section = CONFIG_SECTIONS.find((candidate) => candidate.id === sectionId)!;
  const canEditSection = viewer.canEditSystemConfig || sectionId === "ai";
  const isOverrideSection = !viewer.canEditSystemConfig && sectionId === "ai";

  const resolvedFields: ResolvedField[] = fields.map((field) => {
    const systemValue = initialDrafts[field.key] ?? "";
    const editableKey = isOverrideSection ? buildUserAiOverrideKey(viewer.uid, field.key) : field.key;
    const fallback = isOverrideSection ? systemValue : (initialDrafts[editableKey] ?? systemValue);
    const value = drafts[editableKey] ?? initialDrafts[editableKey] ?? fallback;
    const baseline = initialDrafts[editableKey] ?? fallback;
    const hasOverride = isOverrideSection && values[editableKey] !== undefined;
    return {
      field,
      editableKey,
      value,
      baseline,
      dirty: value !== baseline,
      disabled: !canEditSection || field.kind === "readonly",
      note: isOverrideSection
        ? buildOverrideNote(systemValue, hasOverride)
        : !viewer.canEditSystemConfig && field.kind !== "readonly"
          ? "System setting. Only root can edit this field."
          : null,
    };
  });

  const editableFields = resolvedFields.filter((row) => !row.disabled && row.field.kind !== "readonly");
  const dirty = editableFields.some((row) => row.dirty);
  const saveId = `section:${sectionId}`;

  return (
    <div class="control-detail-pane">
      <header class="control-detail-head">
        <div>
          <h2>{section.label}</h2>
          <p>{section.description}</p>
        </div>
      </header>

      <div class="control-settings-form-grid">
        {resolvedFields.map((row) => (
          <div class={`control-setting-block${isWideField(row.field) ? " is-wide" : ""}`} key={row.editableKey}>
            <label>{row.field.label}</label>
            <p>{row.field.description}</p>
            <FieldInput
              field={row.field}
              value={row.value}
              disabled={row.disabled}
              title={row.disabled ? row.note : null}
              onChange={(nextValue) => onChange(row.editableKey, nextValue)}
            />
            {row.note && !row.disabled ? <div class="control-field-note">{row.note}</div> : null}
          </div>
        ))}
      </div>

      {canEditSection ? (
        <div class="control-section-actions">
          <span class="control-inline-note">{dirty ? "Unsaved changes" : "No changes"}</span>
          <div class="control-section-actions-group">
            <button
              class="control-button"
              disabled={!dirty || pendingSection === saveId}
              onClick={() => onReset(editableFields.map((row) => row.editableKey))}
            >
              Reset
            </button>
            <button
              class="control-button control-button--primary"
              disabled={!dirty || pendingSection === saveId}
              onClick={() => void onSave(saveId, editableFields.map((row) => ({
                key: row.editableKey,
                value: row.value,
              })))}
            >
              {pendingSection === saveId ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      ) : null}

      {extraNote}
    </div>
  );
}

type FieldInputProps = {
  field: ControlSettingField;
  value: string;
  disabled: boolean;
  title: string | null;
  onChange: (value: string) => void;
};

function FieldInput({ field, value, disabled, title, onChange }: FieldInputProps) {
  if (field.kind === "textarea" || field.kind === "json") {
    return (
      <textarea
        title={title ?? undefined}
        class="control-field control-field--textarea"
        rows={field.rows ?? 6}
        value={value}
        disabled={disabled}
        placeholder={field.placeholder}
        onInput={(event) => {
          const target = event.currentTarget as HTMLTextAreaElement;
          onChange(target.value);
        }}
      />
    );
  }

  if (field.kind === "select") {
    return (
      <select
        title={title ?? undefined}
        class="control-field"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const target = event.currentTarget as HTMLSelectElement;
          onChange(target.value);
        }}
      >
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  if (field.kind === "checkbox") {
    return (
      <label class={`control-checkbox-row${disabled ? " is-disabled" : ""}`} title={title ?? undefined}>
        <input
          type="checkbox"
          checked={value === "true"}
          disabled={disabled}
          onInput={(event) => {
            const target = event.currentTarget as HTMLInputElement;
            onChange(target.checked ? "true" : "false");
          }}
        />
        <span>{value === "true" ? "Enabled" : "Disabled"}</span>
      </label>
    );
  }

  if (field.kind === "readonly") {
    return <div class="control-readonly-value">{value || "—"}</div>;
  }

  return (
    <input
      title={title ?? undefined}
      class="control-field"
      type={field.kind === "number" ? "number" : field.kind === "password" ? "password" : "text"}
      value={value}
      disabled={disabled}
      placeholder={field.placeholder}
      onInput={(event) => {
        const target = event.currentTarget as HTMLInputElement;
        onChange(target.value);
      }}
    />
  );
}

type EditorRowProps = {
  label: string;
  description: string;
  rows: number;
  value: string;
  disabled: boolean;
  note: string | null;
  onChange: (value: string) => void;
};

function EditorRow({ label, description, rows, value, disabled, note, onChange }: EditorRowProps) {
  return (
    <div class="control-editor-row">
      <div class="control-setting-meta">
        <label>{label}</label>
        <p>{description}</p>
      </div>
      <div class="control-setting-inputs">
        <textarea
          class="control-field control-field--textarea"
          rows={rows}
          value={value}
          disabled={disabled}
          onInput={(event) => {
            const target = event.currentTarget as HTMLTextAreaElement;
            onChange(target.value);
          }}
        />
        {note ? <div class="control-field-note">{note}</div> : null}
      </div>
    </div>
  );
}

function buildDrafts(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, shouldPrettyPrintJson(key, value) ? prettyJson(value) : value]),
  );
}

function shouldPrettyPrintJson(key: string, value: string): boolean {
  return key.endsWith("/tools/approval") && value.trim().startsWith("{");
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function serializeValue(key: string, value: string): string {
  if (key.endsWith("/tools/approval")) {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return value;
}

function buildOverrideNote(systemValue: string, hasOverride: boolean): string {
  const formatted = summarizeValue(systemValue);
  if (hasOverride) {
    return `Personal override active. System default: ${formatted}`;
  }
  return `Using system default until you save an override. System default: ${formatted}`;
}

function summarizeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "none";
  }
  const singleLine = trimmed.replace(/\s+/g, " ");
  return singleLine.length > 84 ? `${singleLine.slice(0, 81)}…` : singleLine;
}

function isWideField(field: ControlSettingField): boolean {
  return field.kind === "textarea" || field.kind === "json";
}
