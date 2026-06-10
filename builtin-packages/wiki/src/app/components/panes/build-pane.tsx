import type { WikiWorkspaceState } from "../../types";
import { WikiIcon } from "../ui/wiki-icon";

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
          <h2>Build manual</h2>
          <p>Create a first draft collection from a source directory.</p>
        </div>
      </div>
      <form class="wiki-workflow" onSubmit={(event) => void props.onStartBuild(event)}>
        <fieldset>
          <legend>Source</legend>
          <div class="wiki-form-grid">
            <label>
              <span>Source location</span>
              <select value={props.buildTargetMode} onChange={(event) => props.onBuildTargetModeChange((event.currentTarget as HTMLSelectElement).value as TargetMode)}>
                <option value="gsv">GSV workspace</option>
                <option value="custom">Other target</option>
              </select>
            </label>
            {props.buildTargetMode === "custom" ? (
              <label>
                <span>Device or target</span>
                <input value={props.buildTargetCustom} onInput={(event) => props.onBuildTargetCustomChange((event.currentTarget as HTMLInputElement).value)} placeholder="macbook or browser:..." />
              </label>
            ) : <div class="wiki-form-placeholder">Build reads from the GSV workspace by default.</div>}
            <label class="wiki-field-span-2">
              <span>Source directory</span>
              <input value={props.buildSourcePath} onInput={(event) => props.onBuildSourcePathChange((event.currentTarget as HTMLInputElement).value)} placeholder="/home/alice/projects/docs" />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Destination</legend>
          <div class="wiki-toggle-group">
            <button type="button" class={props.buildDestinationMode === "existing" ? "is-active" : ""} onClick={() => props.onBuildDestinationModeChange("existing")}>Use existing collection</button>
            <button type="button" class={props.buildDestinationMode === "new" ? "is-active" : ""} onClick={() => props.onBuildDestinationModeChange("new")}>Create new collection</button>
          </div>
          {props.buildDestinationMode === "existing" ? (
            <label>
              <span>Collection</span>
              <select value={props.buildSelectedDb || props.selectedDb} onChange={(event) => props.onBuildSelectedDbChange((event.currentTarget as HTMLSelectElement).value)}>
                <option value="">Select collection</option>
                {props.state.dbs.map((db) => <option key={db.id} value={db.id}>{db.title || db.id}</option>)}
              </select>
            </label>
          ) : (
            <div class="wiki-form-grid">
              <label>
                <span>Collection title</span>
                <input value={props.buildDbTitle} onInput={(event) => props.onBuildDbTitleChange((event.currentTarget as HTMLInputElement).value)} placeholder="Product manual" />
              </label>
              <label>
                <span>Short id</span>
                <input value={props.buildDbId} onInput={(event) => props.onBuildDbIdChange((event.currentTarget as HTMLInputElement).value)} placeholder="product-manual" />
              </label>
            </div>
          )}
        </fieldset>

        <div class="wiki-inline-actions">
          <button type="submit" disabled={props.mutating} title="Start background build" aria-label="Start background build">
            <WikiIcon name="build" />
            <span>Start build</span>
          </button>
        </div>
      </form>
    </section>
  );
}
