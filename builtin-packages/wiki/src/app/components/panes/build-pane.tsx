import type { WikiWorkspaceState } from "../../types";

type TargetMode = "gsv" | "custom";
type DestinationMode = "existing" | "new";

type Props = {
  state: WikiWorkspaceState;
  selectedDb: string;
  mutating: boolean;
  buildTargetMode: TargetMode;
  buildTargetCustom: string;
  buildSourcePath: string;
  buildDestinationMode: DestinationMode;
  buildSelectedDb: string;
  buildDbTitle: string;
  buildDbId: string;
  onStartBuild(event: Event): Promise<void> | void;
  onBuildTargetModeChange(value: TargetMode): void;
  onBuildTargetCustomChange(value: string): void;
  onBuildSourcePathChange(value: string): void;
  onBuildDestinationModeChange(value: DestinationMode): void;
  onBuildSelectedDbChange(value: string): void;
  onBuildDbTitleChange(value: string): void;
  onBuildDbIdChange(value: string): void;
};

export function BuildPane(props: Props) {
  return (
    <section class="wiki-pane">
      <div class="wiki-pane-head">
        <div>
          <h2>Build from directory</h2>
          <p>Turn a source directory into a first draft wiki without hand-writing database ids and raw prompts.</p>
        </div>
      </div>
      <form class="wiki-workflow" onSubmit={(event) => void props.onStartBuild(event)}>
        <fieldset>
          <legend>Source</legend>
          <div class="wiki-form-grid">
            <label>
              <span>Source target</span>
              <select value={props.buildTargetMode} onChange={(event) => props.onBuildTargetModeChange((event.currentTarget as HTMLSelectElement).value as TargetMode)}>
                <option value="gsv">Control plane (gsv)</option>
                <option value="custom">Other target</option>
              </select>
            </label>
            {props.buildTargetMode === "custom" ? (
              <label>
                <span>Target id</span>
                <input value={props.buildTargetCustom} onInput={(event) => props.onBuildTargetCustomChange((event.currentTarget as HTMLInputElement).value)} placeholder="device id" />
              </label>
            ) : <div class="wiki-form-placeholder">Build reads from the control plane by default.</div>}
            <label class="wiki-field-span-2">
              <span>Source directory</span>
              <input value={props.buildSourcePath} onInput={(event) => props.onBuildSourcePathChange((event.currentTarget as HTMLInputElement).value)} placeholder="/workspaces/project/docs" />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Destination</legend>
          <div class="wiki-toggle-group">
            <button type="button" class={props.buildDestinationMode === "existing" ? "is-active" : ""} onClick={() => props.onBuildDestinationModeChange("existing")}>Use existing database</button>
            <button type="button" class={props.buildDestinationMode === "new" ? "is-active" : ""} onClick={() => props.onBuildDestinationModeChange("new")}>Create new database</button>
          </div>
          {props.buildDestinationMode === "existing" ? (
            <label>
              <span>Database</span>
              <select value={props.buildSelectedDb || props.selectedDb} onChange={(event) => props.onBuildSelectedDbChange((event.currentTarget as HTMLSelectElement).value)}>
                <option value="">Select a database</option>
                {props.state.dbs.map((db) => <option key={db.id} value={db.id}>{db.title || db.id}</option>)}
              </select>
            </label>
          ) : (
            <div class="wiki-form-grid">
              <label>
                <span>Database title</span>
                <input value={props.buildDbTitle} onInput={(event) => props.onBuildDbTitleChange((event.currentTarget as HTMLInputElement).value)} placeholder="Product Alpha" />
              </label>
              <label>
                <span>Database id</span>
                <input value={props.buildDbId} onInput={(event) => props.onBuildDbIdChange((event.currentTarget as HTMLInputElement).value)} placeholder="product-alpha" />
              </label>
            </div>
          )}
        </fieldset>

        <div class="wiki-inline-actions">
          <button type="submit" disabled={props.mutating} title="Start background build" aria-label="Start background build">Start build</button>
        </div>
      </form>
    </section>
  );
}
