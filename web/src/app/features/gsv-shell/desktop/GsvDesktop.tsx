import type { JSX } from "preact";
import { AddAction } from "../../../components/ui/AddAction";
import { GsvMark } from "../../../components/ui/GsvMark";
import { DesktopHint } from "./DesktopHint";
import { IconMenu } from "../../../components/ui/IconMenu";
import { ObjectCard } from "../../../components/ui/ObjectCard";
import { StatusDot } from "../../../components/ui/StatusDot";
import { Tile } from "../../../components/ui/Tile";
import {
  type DesktopChildObject,
  type DesktopObject,
  type DesktopObjectId,
  type ShellStatus,
  type ShellSurfaceId,
} from "../domain/shellModel";

export type DesktopInventoryState = "ready" | "loading" | "offline" | "error";

const DESKTOP_HINT = ["> CLICK A NODE TO EXPLORE", "> CLICK GSV FOR CONTROLS"];
const DESKTOP_HINT_MIN = "CLICK A NODE TO EXPLORE · CLICK GSV FOR CONTROLS";

type GsvDesktopProps = {
  desktopObjects: readonly DesktopObject[];
  inventoryMessage: string;
  inventoryState: DesktopInventoryState;
  selectedObjectId: DesktopObjectId | null;
  gsvOpen: boolean;
  onSelectObject: (id: DesktopObjectId | null) => void;
  onToggleGsv: () => void;
  onCreateObject: (id: DesktopObjectId) => void;
  onOpenObject: (child: DesktopChildObject) => void;
  onOpenSurface: (surface: ShellSurfaceId) => void;
  /** Whether the hint intro has already played this login (skip it if so). */
  hintShown: boolean;
  /** Per-login token; used as the hint's remount key so each login replays it. */
  hintToken: number;
  /** Called once when the hint intro finishes (or is skipped via a node click). */
  onHintShown: () => void;
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


function SpaceGlyphs() {
  const glyphs = ["+", "*", ":", "o", "+", "*", "o", ":", "*", "-", "+", "*", ":", "o", "+", "*", ":", "o"];

  return (
    <div class="gsv-space-glyphs" aria-hidden="true">
      {glyphs.map((glyph, index) => <span key={`${glyph}-${index}`}>{glyph}</span>)}
    </div>
  );
}

function canCreateObject(id: DesktopObjectId): boolean {
  return id === "machines" || id === "messengers" || id === "integrations" || id === "applications";
}

function addObjectLabel(id: DesktopObjectId): string {
  if (id === "machines") {
    return "CONNECT NEW MACHINE";
  }
  if (id === "messengers") {
    return "CONNECT MESSENGER";
  }
  if (id === "integrations") {
    return "NEW INTEGRATION";
  }
  return "NEW APPLICATION";
}

function inventoryTitle(state: DesktopInventoryState, totalObjects: number): string {
  if (state === "loading") {
    return "GSV · LOADING";
  }
  if (state === "offline") {
    return "GSV · OFFLINE";
  }
  if (state === "error") {
    return "GSV · ERROR";
  }
  return `GSV · ${totalObjects} OBJECTS`;
}

export function GsvDesktop({
  desktopObjects,
  inventoryMessage,
  inventoryState,
  selectedObjectId,
  gsvOpen,
  onSelectObject,
  onToggleGsv,
  onCreateObject,
  onOpenObject,
  onOpenSurface,
  hintShown,
  hintToken,
  onHintShown,
}: GsvDesktopProps) {
  const selectedObject = selectedObjectId
    ? desktopObjects.find((object) => object.id === selectedObjectId) ?? null
    : null;
  const branchCount = Math.max(desktopObjects.length, 1);
  const totalObjects = desktopObjects.reduce((sum, object) => sum + object.children.length, 0);
  const desktopStateClass = `${selectedObject ? " has-selected-object" : ""}${gsvOpen ? " has-gsv-open" : ""}`;
  const inventoryReady = inventoryState === "ready";
  const hudStatus = selectedObject
    ? selectedObject.statusLabel
    : gsvOpen
      ? "GSV / CONTROL"
      : inventoryReady
        ? "SYSTEM MAP"
        : inventoryState.toUpperCase();

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
      <SpaceGlyphs />

      <header class="gsv-space-hud">
        <div>
          <span>DESKTOP // GSV</span>
          <strong>{selectedObject ? `GSV / ${selectedObject.label}` : inventoryTitle(inventoryState, totalObjects)}</strong>
          <small>
            {selectedObject
              ? `${selectedObject.meta} · ${selectedObject.statusLabel}`
              : inventoryMessage}
          </small>
        </div>
        <p>{hudStatus}</p>
      </header>

      {/* The tree fills the desktop; clicks on its empty space intentionally
          bubble to the section handler to deselect. Interactive children below
          stop propagation so they don't trigger a deselect. */}
      <div class="gsv-space-tree">
        <div class="gsv-space-gsv">
          <button
            type="button"
            class={`gsv-space-gsv-button${gsvOpen ? " is-open" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleGsv();
            }}
          >
            <span class="gsv-space-gsv-cross" aria-hidden="true" />
            <GsvMark variant="master" size={50} />
          </button>
          <div class="gsv-space-gsv-label">GSV</div>
        </div>

        {gsvOpen ? (
          <>
            <span class="gsv-space-control-line" aria-hidden="true" />
            <div
              class="gsv-space-control-popover"
              aria-label="GSV controls"
              onClick={(event) => event.stopPropagation()}
            >
              <IconMenu
                title="GSV // CONTROL"
                width={386}
                onClose={onToggleGsv}
                onFiles={() => onOpenSurface("files")}
                onLibrary={() => onOpenSurface("library")}
                onTerminal={() => onOpenSurface("terminal")}
                onSettings={() => onOpenSurface("settings")}
              />
            </div>
          </>
        ) : null}

        {inventoryReady ? (
          <>
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
                  onClick={(event) => {
                    event.stopPropagation();
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
          </>
        ) : (
          <div class={`gsv-space-inventory-state is-${inventoryState}`}>
            <StatusDot tone={inventoryState === "error" ? "error" : inventoryState === "offline" ? "idle" : "warn"} size={8} />
            <span>{inventoryMessage}</span>
          </div>
        )}

        {selectedObject ? (
          <aside
            class="gsv-object-strip"
            aria-label={`${selectedObject.label} objects`}
            onClick={(event) => event.stopPropagation()}
          >
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
                  onClick={() => onOpenObject(child)}
                />
              ))}
              {canCreateObject(selectedObject.id) ? (
                <div class="gsv-object-strip-add">
                  <AddAction
                    variant="tile"
                    label={addObjectLabel(selectedObject.id)}
                    onClick={() => onCreateObject(selectedObject.id)}
                  />
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      <DesktopHint
        key={hintToken}
        lines={DESKTOP_HINT}
        minimizedText={DESKTOP_HINT_MIN}
        collapse={selectedObject != null}
        played={hintShown}
        onPlayed={onHintShown}
      />
    </section>
  );
}
