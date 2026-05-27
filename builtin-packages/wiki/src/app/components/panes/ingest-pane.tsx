import type { WikiWorkspaceState } from "../../types";

type TargetMode = "gsv" | "custom";

type Props = {
  state: WikiWorkspaceState;
  selectedDb: string;
  mutating: boolean;
  ingestDb: string;
  ingestTargetMode: TargetMode;
  ingestTargetCustom: string;
  ingestSourcePath: string;
  ingestSourceTitle: string;
  ingestSummary: string;
  onIngestSource(event: Event): Promise<void> | void;
  onIngestDbChange(value: string): void;
  onIngestTargetModeChange(value: TargetMode): void;
  onIngestTargetCustomChange(value: string): void;
  onIngestSourcePathChange(value: string): void;
  onIngestSourceTitleChange(value: string): void;
  onIngestSummaryChange(value: string): void;
};

export function IngestPane(props: Props) {
  return (
    <section class="wiki-pane">
      <div class="wiki-pane-head">
        <div>
          <h2>Ingest source</h2>
          <p>Stage a file or directory into inbox without hand-writing raw source specs.</p>
        </div>
      </div>
      <form class="wiki-workflow" onSubmit={(event) => void props.onIngestSource(event)}>
        <div class="wiki-form-grid">
          <label>
            <span>Destination database</span>
            <select value={props.ingestDb || props.selectedDb} onChange={(event) => props.onIngestDbChange((event.currentTarget as HTMLSelectElement).value)}>
              <option value="">Select a database</option>
              {props.state.dbs.map((db) => <option key={db.id} value={db.id}>{db.title || db.id}</option>)}
            </select>
          </label>
          <label>
            <span>Source target</span>
            <select value={props.ingestTargetMode} onChange={(event) => props.onIngestTargetModeChange((event.currentTarget as HTMLSelectElement).value as TargetMode)}>
              <option value="gsv">Control plane (gsv)</option>
              <option value="custom">Other target</option>
            </select>
          </label>
          {props.ingestTargetMode === "custom" ? (
            <label>
              <span>Target id</span>
              <input value={props.ingestTargetCustom} onInput={(event) => props.onIngestTargetCustomChange((event.currentTarget as HTMLInputElement).value)} placeholder="device id" />
            </label>
          ) : <div class="wiki-form-placeholder">Use a custom target only when the source corpus lives outside gsv.</div>}
          <label class="wiki-field-span-2">
            <span>Source path</span>
            <input value={props.ingestSourcePath} onInput={(event) => props.onIngestSourcePathChange((event.currentTarget as HTMLInputElement).value)} placeholder="/home/alice/projects/docs/plan.md" />
          </label>
          <label>
            <span>Source title</span>
            <input value={props.ingestSourceTitle} onInput={(event) => props.onIngestSourceTitleChange((event.currentTarget as HTMLInputElement).value)} placeholder="Optional title for the staged note" />
          </label>
          <label>
            <span>Summary</span>
            <input value={props.ingestSummary} onInput={(event) => props.onIngestSummaryChange((event.currentTarget as HTMLInputElement).value)} placeholder="Optional context for the inbox note" />
          </label>
        </div>
        <div class="wiki-inline-actions">
          <button type="submit" disabled={props.mutating} title="Stage source in inbox" aria-label="Stage source in inbox">Stage</button>
        </div>
      </form>
    </section>
  );
}
