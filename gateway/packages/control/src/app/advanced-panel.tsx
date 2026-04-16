import { useEffect, useMemo, useState } from "preact/hooks";
import type { ControlConfigEntry } from "./types";

type AdvancedPanelProps = {
  entries: ControlConfigEntry[];
  pendingAction: string | null;
  onApply: (entries: Array<{ key: string; value: string }>) => Promise<void>;
  onClientError: (message: string | null) => void;
};

export function AdvancedPanel({ entries, pendingAction, onApply, onClientError }: AdvancedPanelProps) {
  const initialDraft = useMemo(
    () => JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.key, entry.value])), null, 2),
    [entries],
  );
  const [draft, setDraft] = useState(initialDraft);

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  function handleApply(): void {
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      const nextEntries = Object.entries(parsed).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
      }));
      onClientError(null);
      void onApply(nextEntries);
    } catch (error) {
      onClientError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div class="control-advanced-stage">
      <section class="control-pane">
        <header class="control-detail-head">
          <div>
            <h2>Advanced config</h2>
            <p>Escape hatch for raw config editing. Use this for unmodeled keys, package flags, and per-user overrides.</p>
          </div>
        </header>
        <textarea
          class="control-field control-field--textarea control-field--raw"
          value={draft}
          onInput={(event) => {
            const target = event.currentTarget as HTMLTextAreaElement;
            setDraft(target.value);
          }}
        />
        <div class="control-actions-bar">
          <button class="control-button control-button--primary" disabled={pendingAction === "raw-save"} onClick={handleApply}>
            {pendingAction === "raw-save" ? "Applying…" : "Apply raw updates"}
          </button>
          <button class="control-button" disabled={pendingAction === "raw-save"} onClick={() => setDraft(initialDraft)}>
            Reset
          </button>
        </div>
      </section>

      <section class="control-pane">
        <header class="control-detail-head">
          <div>
            <h2>Visible keys</h2>
            <p>Reference list of config keys currently visible to this user.</p>
          </div>
        </header>
        <div class="control-table-wrap">
          <table class="control-table">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Path</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.key}>
                  <td>{entry.scopeLabel}</td>
                  <td><code>{entry.pathLabel}</code></td>
                  <td><code>{entry.value}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
