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

type ConfigPanelProps = {
  entries: ControlConfigEntry[];
  values: Record<string, string>;
  pendingKey: string | null;
  activeSection: ControlConfigSectionId;
  onSelectSection: (section: ControlConfigSectionId) => void;
  onSaveEntry: (key: string, value: string) => Promise<void>;
};

export function ConfigPanel({
  entries,
  values,
  pendingKey,
  activeSection,
  onSelectSection,
  onSaveEntry,
}: ConfigPanelProps) {
  const [selectedProfile, setSelectedProfile] = useState<ControlProfileId>("task");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const nextDrafts = useMemo(() => buildDrafts(values), [values]);

  useEffect(() => {
    setDrafts(nextDrafts);
  }, [nextDrafts]);

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

  async function saveField(field: ControlSettingField): Promise<void> {
    await onSaveEntry(field.key, drafts[field.key] ?? values[field.key] ?? "");
  }

  async function saveProfileField(key: string): Promise<void> {
    await onSaveEntry(key, drafts[key] ?? values[key] ?? "");
  }

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
        {activeSection === "ai" ? (
          <ConfigFieldGroup
            title="AI defaults"
            description="System-wide model selection and inference defaults used across built-in profiles unless explicitly overridden elsewhere."
            fields={AI_FIELDS}
            values={values}
            drafts={drafts}
            pendingKey={pendingKey}
            onDraftChange={(update) => setDrafts(update)}
            onSave={saveField}
          />
        ) : null}

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
                    keyPath={key}
                    rows={field.rows}
                    value={drafts[key] ?? values[key] ?? ""}
                    isSaving={pendingKey === key}
                    onChange={(nextValue) => {
                      setDrafts((current) => ({ ...current, [key]: nextValue }));
                    }}
                    onSave={() => void saveProfileField(key)}
                  />
                );
              })}

              {(() => {
                const approvalKey = buildProfileApprovalKey(selectedProfile);
                return (
                  <EditorRow
                    key={approvalKey}
                    label="Tool approval policy"
                    description="Ordered approval rules for the selected profile. Stored as JSON with a default action and a rules array."
                    keyPath={approvalKey}
                    rows={10}
                    value={drafts[approvalKey] ?? values[approvalKey] ?? ""}
                    isSaving={pendingKey === approvalKey}
                    onChange={(nextValue) => {
                      setDrafts((current) => ({ ...current, [approvalKey]: nextValue }));
                    }}
                    onSave={() => void saveProfileField(approvalKey)}
                  />
                );
              })()}
            </div>
          </div>
        ) : null}

        {activeSection === "shell" ? (
          <ConfigFieldGroup
            title="Shell"
            description="Execution behavior for native shell usage across the system."
            fields={SHELL_FIELDS}
            values={values}
            drafts={drafts}
            pendingKey={pendingKey}
            onDraftChange={(update) => setDrafts(update)}
            onSave={saveField}
          />
        ) : null}

        {activeSection === "server" ? (
          <ConfigFieldGroup
            title="Server"
            description="Instance identity and metadata visible throughout the runtime."
            fields={SERVER_FIELDS}
            values={values}
            drafts={drafts}
            pendingKey={pendingKey}
            onDraftChange={(update) => setDrafts(update)}
            onSave={saveField}
          />
        ) : null}

        {activeSection === "processes" ? (
          <ConfigFieldGroup
            title="Processes"
            description="Controls for init process naming and per-user process limits."
            fields={PROCESS_FIELDS}
            values={values}
            drafts={drafts}
            pendingKey={pendingKey}
            onDraftChange={(update) => setDrafts(update)}
            onSave={saveField}
          />
        ) : null}

        {activeSection === "automation" ? (
          <div class="control-detail-pane">
            <ConfigFieldGroup
              title="Automation"
              description="Scheduling controls for background archivist and curator runs."
              fields={AUTOMATION_FIELDS}
              values={values}
              drafts={drafts}
              pendingKey={pendingKey}
              onDraftChange={(update) => setDrafts(update)}
              onSave={saveField}
            />

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
                  {uncategorizedEntries.length > 8 ? (
                    <li>…and {uncategorizedEntries.length - 8} more</li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

type ConfigFieldGroupProps = {
  title: string;
  description: string;
  fields: ControlSettingField[];
  values: Record<string, string>;
  drafts: Record<string, string>;
  pendingKey: string | null;
  onDraftChange: (update: (current: Record<string, string>) => Record<string, string>) => void;
  onSave: (field: ControlSettingField) => Promise<void>;
};

function ConfigFieldGroup({
  title,
  description,
  fields,
  values,
  drafts,
  pendingKey,
  onDraftChange,
  onSave,
}: ConfigFieldGroupProps) {
  return (
    <div class="control-detail-pane">
      <header class="control-detail-head">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <div class="control-setting-list">
        {fields.map((field) => {
          const value = drafts[field.key] ?? values[field.key] ?? "";
          const isSaving = pendingKey === field.key;
          const isReadOnly = field.kind === "readonly";
          return (
            <div class="control-setting-row" key={field.key}>
              <div class="control-setting-meta">
                <label>{field.label}</label>
                <p>{field.description}</p>
                <code>{field.key}</code>
              </div>
              <div class="control-setting-inputs">
                <FieldInput
                  field={field}
                  value={value}
                  onChange={(nextValue) => {
                    onDraftChange((current) => ({ ...current, [field.key]: nextValue }));
                  }}
                />
                {isReadOnly ? (
                  <span class="control-inline-note">Read-only runtime field.</span>
                ) : (
                  <button
                    class="control-button control-button--primary"
                    disabled={isSaving}
                    onClick={() => void onSave(field)}
                  >
                    {isSaving ? "Saving…" : "Save"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
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
  keyPath: string;
  rows: number;
  value: string;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

function EditorRow({
  label,
  description,
  keyPath,
  rows,
  value,
  isSaving,
  onChange,
  onSave,
}: EditorRowProps) {
  return (
    <div class="control-editor-row">
      <div class="control-setting-meta">
        <label>{label}</label>
        <p>{description}</p>
        <code>{keyPath}</code>
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
        <button class="control-button control-button--primary" disabled={isSaving} onClick={onSave}>
          {isSaving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function buildDrafts(values: Record<string, string>): Record<string, string> {
  const entries = Object.entries(values).map(([key, value]) => [key, shouldPrettyPrintJson(key, value) ? prettyJson(value) : value]);
  return Object.fromEntries(entries);
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
