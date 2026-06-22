import type { JSX } from "preact";
import { IconMenu } from "../../../components/ui/IconMenu";
import { ObjectCard } from "../../../components/ui/ObjectCard";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Tile } from "../../../components/ui/Tile";
import {
  type DesktopObject,
  type DesktopObjectId,
  type ShellStatus,
  type ShellSurfaceId,
} from "../domain/shellModel";

type GsvDesktopProps = {
  desktopObjects: readonly DesktopObject[];
  selectedObjectId: DesktopObjectId | null;
  gsvOpen: boolean;
  tabCount: number;
  onSelectObject: (id: DesktopObjectId | null) => void;
  onToggleGsv: () => void;
  onOpenSurface: (surface: ShellSurfaceId) => void;
  onActivateTabs: () => void;
};

function objectCardStatus(status: ShellStatus) {
  return status === "update" ? "warn" : status;
}

function treeWidth(count: number): number {
  return Math.max(96, count * 96 + Math.max(0, count - 1) * 64);
}

function branchStyle(index: number, count: number): JSX.CSSProperties {
  const width = treeWidth(count);
  const left = count <= 1 ? 50 : ((48 + index * 160) / width) * 100;

  return {
    "--gsv-branch-left": `${left}%`,
  } as JSX.CSSProperties;
}

function branchCountStyle(count: number): JSX.CSSProperties {
  return {
    "--gsv-branch-count": count,
    "--gsv-tree-width": `${treeWidth(count)}px`,
  } as JSX.CSSProperties;
}

function surfaceForObject(parentId: DesktopObjectId): ShellSurfaceId {
  if (parentId === "machines") {
    return "machines";
  }
  if (parentId === "applications") {
    return "library";
  }
  return "settings";
}

function GsvMark() {
  return (
    <svg width="50" height="50" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="var(--text-hi)" shape-rendering="crispEdges">
        <rect x="7" y="1" width="2" height="2" />
        <rect x="6" y="3" width="4" height="6" />
        <rect x="4" y="6" width="2" height="3" />
        <rect x="10" y="6" width="2" height="3" />
        <rect x="7" y="11" width="2" height="3" fill="#a9a4ff" />
      </g>
    </svg>
  );
}

export function GsvDesktop({
  desktopObjects,
  selectedObjectId,
  gsvOpen,
  tabCount,
  onSelectObject,
  onToggleGsv,
  onOpenSurface,
  onActivateTabs,
}: GsvDesktopProps) {
  const selectedObject = selectedObjectId
    ? desktopObjects.find((object) => object.id === selectedObjectId) ?? null
    : null;
  const branchCount = Math.max(desktopObjects.length, 1);
  const totalObjects = desktopObjects.reduce((sum, object) => sum + object.children.length, 0);
  const desktopStateClass = `${selectedObject ? " has-selected-object" : ""}${gsvOpen ? " has-gsv-open" : ""}`;

  return (
    <section
      class={`gsv-space${desktopStateClass}`}
      aria-label="GSV desktop"
      onClick={() => {
        onSelectObject(null);
      }}
    >
      <div class="gsv-space-grid" aria-hidden="true" />
      <div class="gsv-space-stars" aria-hidden="true" />
      <div class="gsv-space-nebula" aria-hidden="true" />

      <header class="gsv-space-hud">
        <div>
          <span>DESKTOP // GSV</span>
          <strong>{selectedObject ? `GSV / ${selectedObject.label}` : `GSV · ${totalObjects} OBJECTS`}</strong>
          <small>
            {selectedObject
              ? `${selectedObject.meta} · ${selectedObject.statusLabel}`
              : tabCount > 0
                ? `${tabCount} open ${tabCount === 1 ? "tab" : "tabs"}`
                : "desktop ready"}
          </small>
        </div>
        <p>
          {selectedObject
            ? "click a child to open · click empty space to exit"
            : gsvOpen
              ? "select a control · click empty space to close"
              : "click a node to explore · click GSV for controls"}
        </p>
      </header>

      <div
        class="gsv-space-tree"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div class="gsv-space-gsv">
          <button
            type="button"
            class={`gsv-space-gsv-button${gsvOpen ? " is-open" : ""}`}
            onClick={onToggleGsv}
          >
            <span class="gsv-space-gsv-cross" aria-hidden="true" />
            <GsvMark />
          </button>
          <div class="gsv-space-gsv-label">GSV</div>
        </div>

        {gsvOpen ? (
          <>
            <span class="gsv-space-control-line" aria-hidden="true" />
            <div class="gsv-space-control-popover" aria-label="GSV controls">
              <IconMenu
                title="GSV // CONTROL"
                width={386}
                onClose={onToggleGsv}
                onRuntime={() => onOpenSurface("runtime")}
                onFiles={() => onOpenSurface("files")}
                onLibrary={() => onOpenSurface("library")}
                onTerminal={() => onOpenSurface("terminal")}
                onSettings={() => onOpenSurface("settings")}
              />
            </div>
          </>
        ) : null}

        <div
          class={`gsv-space-connectors${gsvOpen ? " is-control-open" : ""}`}
          style={branchCountStyle(branchCount)}
          aria-hidden="true"
        >
          <span />
          <i />
          {desktopObjects.map((object, index) => (
            <b key={object.id} style={branchStyle(index, branchCount)} />
          ))}
        </div>

        <div class="gsv-space-tiles" style={branchCountStyle(branchCount)}>
          {desktopObjects.map((object) => (
            <button
              key={object.id}
              type="button"
              class={`gsv-space-tile-button${selectedObjectId === object.id ? " is-selected" : ""}`}
              aria-pressed={selectedObjectId === object.id ? "true" : "false"}
              title={`${object.label}: ${object.meta}, ${object.statusLabel}`}
              onClick={() => {
                onSelectObject(selectedObjectId === object.id ? null : object.id);
              }}
            >
              <Tile
                label={object.label}
                glyph={object.glyph}
                status={object.status}
                selected={selectedObjectId === object.id}
              />
            </button>
          ))}
        </div>

        {selectedObject ? (
          <aside class="gsv-object-strip" aria-label={`${selectedObject.label} objects`}>
            <header>
              <span>{selectedObject.label} · OBJECTS</span>
              <small>{selectedObject.meta}</small>
              <strong>
                <StatusDot tone={selectedObject.status} size={7} />
                {selectedObject.statusLabel}
              </strong>
            </header>
            <div>
              {selectedObject.children.length === 0 ? (
                <div class="gsv-object-strip-empty">NO OBJECTS</div>
              ) : selectedObject.children.map((child) => (
                <ObjectCard
                  key={child.id}
                  label={child.label}
                  type={child.type}
                  blurb={child.blurb}
                  glyph={child.glyph}
                  status={objectCardStatus(child.status)}
                  width={236}
                  onClick={() => onOpenSurface(surfaceForObject(selectedObject.id))}
                />
              ))}
            </div>
          </aside>
        ) : null}
      </div>

      {tabCount > 0 ? (
        <button type="button" class="gsv-space-tabs-card" onClick={onActivateTabs}>
          <span>TABS</span>
          <strong>{tabCount}</strong>
          <small>select</small>
        </button>
      ) : null}

      <div class="gsv-space-hint">
        {selectedObject ? "CLICK A CHILD TO OPEN · CLICK EMPTY SPACE TO EXIT" : "CLICK A NODE TO EXPLORE · CLICK GSV FOR CONTROLS"}
      </div>
    </section>
  );
}
