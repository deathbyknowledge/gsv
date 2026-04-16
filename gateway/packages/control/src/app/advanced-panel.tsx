import { useEffect, useMemo, useState } from "preact/hooks";
import type { ControlConfigEntry } from "./types";

type AdvancedPanelProps = {
  entries: ControlConfigEntry[];
  pendingAction: string | null;
  onApply: (entries: Array<{ key: string; value: string }>) => Promise<void>;
};

export function AdvancedPanel({ entries, pendingAction, onApply }: AdvancedPanelProps) {
  const initialDraft = useMemo(
    () => JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.key, entry.value])), null, 2),
    [entries],
  );
  const [draft, setDraft] = useState(initialDraft);

  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  return (
    <section class="control-card control-card--full-width">
      <header class="control-card__header">
        <div>
          <h2>Raw config editor</h2>
          <p>Apply key/value updates in bulk. Deletions are not supported from this view.</p>
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
      <div class="control-actions-row">
        <button
          class="control-button control-button--primary"
          disabled={pendingAction === "raw-save"}
          onClick={() => {
            const parsed = JSON.parse(draft) as Record<string, unknown>;
            const nextEntries = Object.entries(parsed).map(([key, value]) => ({
              key,
              value: typeof value === "string" ? value : JSON.stringify(value),
            }));
            void onApply(nextEntries);
          }}
        >
          {pendingAction === "raw-save" ? "Applying…" : "Apply raw updates"}
        </button>
        <button
          class="control-button"
          disabled={pendingAction === "raw-save"}
          onClick={() => setDraft(initialDraft)}
        >
          Reset
        </button>
      </div>
    </section>
  );
}
