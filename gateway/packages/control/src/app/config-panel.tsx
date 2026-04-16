import { useEffect, useMemo, useState } from "preact/hooks";
import {
  AI_FIELDS,
  AUTOMATION_FIELDS,
  buildProfileApprovalKey,
  buildProfileContextKey,
  CONFIG_SECTIONS,
  PROCESS_FIELDS,
  PROFILE_CONTEXT_FIELDS,
  PROFILE_OPTIONS,
  SERVER_FIELDS,
  SHELL_FIELDS,
  type ControlProfileId,
  type ControlSettingField,
} from "./config-schema";
import type { ControlConfigEntry, ControlConfigSectionId } from "./types";

type SaveEntry = {
  key: string;
  value: string;
};

type ConfigPanelProps = {
  entries: ControlConfigEntry[];
  values: Record<string, string>;
  pendingSection: string | null;
  activeSection: ControlConfigSectionId;
  onSelectSection: (section: ControlConfigSectionId) => void;
  onSaveEntries: (saveId: string, entries: SaveEntry[]) => Promise<void>;
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

  const profileKeys = useMemo(() => {
    const keys = PROFILE_CONTEXT_FIELDS.map((field) => buildProfileContextKey(selectedProfile, field.file));
    keys.push(buildProfileApprovalKey(selectedProfile));
    return keys;
  }, [selectedProfile]);

  function currentValue(key: string): string {
    return drafts[key] ?? initialDrafts[key] ?? "";
  }

  function isDirty(keys: string[]): boolean {
    return keys.some((key) => currentValue(key) !== (initialDrafts[key] ?? ""));
  }

  function resetKeys(keys: string[]): void {
    setDrafts((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = initialDrafts[key] ?? "";
      }
      return next;
    });
  }

  async function saveKeys(saveId: string, keys: string[]): Promise<void> {
    const payload = keys.map((key) => ({
      key,
      value: serializeValue(key, currentValue(key)),
    }));
    await onSaveEntries(saveId, payload);
  }

  function updateDraft(key: string, value: string): void {
    setDrafts((current) => ({ ...current, [key]: value }));
  }

  const profileDirty = isDirty(profileKeys);
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
              {PROFILE_CONTEXT_FIELDS.map((field) => {
                const key = buildProfileContextKey(selectedProfile, field.file);
                return (
                  <EditorRow
                    key={key}
                    label={field.label}
                    description={field.description}
                    rows={field.rows}
                    value={currentValue(key)}
                    onChange={(nextValue) => updateDraft(key, nextValue)}
                  />
                );
              })}

              <EditorRow
                label="Tool approval policy"
                description="Ordered approval rules for the selected profile. Stored as JSON with a default action and a rules array."
                rows={10}
                value={currentValue(buildProfileApprovalKey(selectedProfile))}
                onChange={(nextValue) => updateDraft(buildProfileApprovalKey(selectedProfile), nextValue)}
              />
            </div>

            <div class="control-section-actions">
              <span class="control-inline-note">{profileDirty ? "Unsaved changes" : "No changes"}</span>
              <div class="control-section-actions-group">
                <button
                  class="control-button"
                  disabled={!profileDirty || pendingSection === profileSaveId}
                  onClick={() => resetKeys(profileKeys)}
                >
                  Reset
                </button>
                <button
                  class="control-button control-button--primary"
                  disabled={!profileDirty || pendingSection === profileSaveId}
                  onClick={() => void saveKeys(profileSaveId, profileKeys)}
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
            values={initialDrafts}
            currentValue={currentValue}
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
  currentValue: (key: string) => string;
  pendingSection: string | null;
  onChange: (key: string, value: string) => void;
  onReset: (keys: string[]) => void;
  onSave: (saveId: string, keys: string[]) => Promise<void>;
  extraNote?: import("preact").ComponentChildren;
};

function SectionForm({
  sectionId,
  fields,
  values,
  currentValue,
  pendingSection,
  onChange,
  onReset,
  onSave,
  extraNote,
}: SectionFormProps) {
  const section = CONFIG_SECTIONS.find((candidate) => candidate.id === sectionId)!;
  const editableKeys = fields.filter((field) => field.kind !== "readonly").map((field) => field.key);
  const dirty = editableKeys.some((key) => currentValue(key) !== (values[key] ?? ""));
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
        {fields.map((field) => (
          <div class={`control-setting-block${isWideField(field) ? " is-wide" : ""}`} key={field.key}>
            <label>{field.label}</label>
            <p>{field.description}</p>
            <FieldInput
              field={field}
              value={currentValue(field.key)}
              onChange={(nextValue) => onChange(field.key, nextValue)}
            />
          </div>
        ))}
      </div>

      <div class="control-section-actions">
        <span class="control-inline-note">{dirty ? "Unsaved changes" : "No changes"}</span>
        <div class="control-section-actions-group">
          <button
            class="control-button"
            disabled={!dirty || pendingSection === saveId}
            onClick={() => onReset(editableKeys)}
          >
            Reset
          </button>
          <button
            class="control-button control-button--primary"
            disabled={!dirty || pendingSection === saveId}
            onClick={() => void onSave(saveId, editableKeys)}
          >
            {pendingSection === saveId ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {extraNote}
    </div>
  );
}

type FieldInputProps = {
  field: ControlSettingField;
  value: string;
  onChange: (value: string) => void;
};

function FieldInput({ field, value, onChange }: FieldInputProps) {
  if (field.kind === "textarea" || field.kind === "json") {
    return (
      <textarea
        class="control-field control-field--textarea"
        rows={field.rows ?? 6}
        value={value}
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
        class="control-field"
        value={value}
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
      <label class="control-checkbox-row">
        <input
          type="checkbox"
          checked={value === "true"}
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
      class="control-field"
      type={field.kind === "number" ? "number" : field.kind === "password" ? "password" : "text"}
      value={value}
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
  onChange: (value: string) => void;
};

function EditorRow({ label, description, rows, value, onChange }: EditorRowProps) {
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
          onInput={(event) => {
            const target = event.currentTarget as HTMLTextAreaElement;
            onChange(target.value);
          }}
        />
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

function isWideField(field: ControlSettingField): boolean {
  return field.kind === "textarea" || field.kind === "json";
}
