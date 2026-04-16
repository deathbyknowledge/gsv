import { useEffect, useMemo, useState } from "preact/hooks";
import type { ControlSection, ControlSectionId } from "./types";

type ConfigPanelProps = {
  sections: ControlSection[];
  pendingKey: string | null;
  onSaveEntry: (key: string, value: string) => Promise<void>;
};

export function ConfigPanel({ sections, pendingKey, onSaveEntry }: ConfigPanelProps) {
  const draftEntries = useMemo(
    () => Object.fromEntries(sections.flatMap((section) => section.entries.map((entry) => [entry.key, entry.value]))),
    [sections],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(draftEntries);
  const [newRows, setNewRows] = useState<Record<ControlSectionId, { suffix: string; value: string }>>({
    ai: { suffix: "", value: "" },
    shell: { suffix: "", value: "" },
    server: { suffix: "", value: "" },
    auth: { suffix: "", value: "" },
  });

  useEffect(() => {
    setDrafts(draftEntries);
  }, [draftEntries]);

  async function handleSave(key: string): Promise<void> {
    await onSaveEntry(key, drafts[key] ?? "");
  }

  async function handleAdd(section: ControlSection): Promise<void> {
    const row = newRows[section.id];
    const suffix = row.suffix.trim().replace(/^\/+/, "");
    if (!suffix) {
      throw new Error(`New ${section.title} keys need a field path`);
    }
    const key = `${section.addPrefix}${suffix}`;
    await onSaveEntry(key, row.value);
    setNewRows((current) => ({
      ...current,
      [section.id]: { suffix: "", value: "" },
    }));
  }

  return (
    <div class="control-grid control-grid--stacked">
      {sections.map((section) => (
        <section class="control-card" key={section.id}>
          <header class="control-card__header">
            <div>
              <h2>{section.title}</h2>
              <p>{section.description}</p>
            </div>
          </header>
          <div class="control-table-wrap">
            <table class="control-table control-table--config">
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Key</th>
                  <th>Value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {section.entries.length === 0 ? (
                  <tr>
                    <td colSpan={4} class="control-empty-cell">No visible entries in this section.</td>
                  </tr>
                ) : section.entries.map((entry) => (
                  <tr key={entry.key}>
                    <td><span class="control-pill">{entry.scopeLabel}</span></td>
                    <td>
                      <code>{entry.fieldLabel}</code>
                      <div class="control-subtle">{entry.key}</div>
                    </td>
                    <td>
                      <textarea
                        class="control-field control-field--textarea"
                        rows={3}
                        value={drafts[entry.key] ?? ""}
                        onInput={(event) => {
                          const target = event.currentTarget as HTMLTextAreaElement;
                          setDrafts((current) => ({
                            ...current,
                            [entry.key]: target.value,
                          }));
                        }}
                      />
                    </td>
                    <td class="control-actions-cell">
                      <button
                        class="control-button control-button--primary"
                        disabled={pendingKey === entry.key}
                        onClick={() => void handleSave(entry.key)}
                      >
                        {pendingKey === entry.key ? "Saving…" : "Save"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="control-inline-form control-inline-form--compact">
            <input
              class="control-field"
              type="text"
              placeholder={`New ${section.id} key, e.g. model or provider/default`}
              value={newRows[section.id].suffix}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setNewRows((current) => ({
                  ...current,
                  [section.id]: { ...current[section.id], suffix: target.value },
                }));
              }}
            />
            <input
              class="control-field"
              type="text"
              placeholder="Value"
              value={newRows[section.id].value}
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setNewRows((current) => ({
                  ...current,
                  [section.id]: { ...current[section.id], value: target.value },
                }));
              }}
            />
            <button
              class="control-button"
              disabled={pendingKey !== null}
              onClick={() => void handleAdd(section)}
            >
              Add key
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
