import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
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
  onCloseGsv: () => void;
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
  // Messengers are intentionally absent — they always list Telegram + Discord,
  // and connecting one is done from its platform card, not a generic "connect
  // new" card (matches the rail drawer convention).
  return id === "machines" || id === "integrations" || id === "applications";
}

function addObjectLabel(id: DesktopObjectId): string {
  if (id === "machines") {
    return "CONNECT NEW MACHINE";
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
  onCloseGsv,
  onCreateObject,
  onOpenObject,
  onOpenSurface,
  hintShown,
  hintToken,
  onHintShown,
}: GsvDesktopProps) {
  const [hoveredObjectId, setHoveredObjectId] = useState<DesktopObjectId | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  const selectedObject = selectedObjectId
    ? desktopObjects.find((object) => object.id === selectedObjectId) ?? null
    : null;
  // Hovering a tile previews its children; selection persists them. Hover takes
  // precedence so you can peek at other nodes while one is selected.
  const activeObjectId = hoveredObjectId ?? selectedObjectId;
  const activeObject = activeObjectId
    ? desktopObjects.find((object) => object.id === activeObjectId) ?? null
    : null;

  // Hovering the GSV mark previews the controls; clicking persists them. A short
  // grace delay lets the pointer travel from the mark into the popover.
  const [gsvHovered, setGsvHovered] = useState(false);
  const gsvHoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openGsvHover = () => {
    if (gsvHoverTimer.current) clearTimeout(gsvHoverTimer.current);
    setGsvHovered(true);
  };
  const closeGsvHover = () => {
    if (gsvHoverTimer.current) clearTimeout(gsvHoverTimer.current);
    gsvHoverTimer.current = setTimeout(() => setGsvHovered(false), 140);
  };
  const closeGsvControls = () => {
    if (gsvHoverTimer.current) clearTimeout(gsvHoverTimer.current);
    setGsvHovered(false);
    // Idempotent close — not the functional toggle. Outside-click also calls
    // onSelectObject(null), which already clears gsvOpen in the parent; a toggle
    // here would flip it back open within the same batched update.
    if (gsvOpen) onCloseGsv();
  };
  useEffect(() => () => {
    if (gsvHoverTimer.current) clearTimeout(gsvHoverTimer.current);
  }, []);
  const gsvActive = gsvOpen || gsvHovered;

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

  // When a node is selected, settle the view so its objects are readable: scroll
  // up to centre the strip, but never past the point where the tiles row sits at
  // the top. If the strip still overflows, pin the tiles and let the card grid
  // scroll on its own. Driven by selection (not hover) so previews don't scroll.
  const selectedChildCount = selectedObject?.children.length ?? 0;
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    function position() {
      const sec = sectionRef.current;
      if (!sec) return;
      const strip = stripRef.current;
      const tiles = tilesRef.current;
      const cards = cardsRef.current;
      // Reset any prior inner-scroll cap + outer lock so we measure natural heights.
      sec.style.overflowY = "";
      if (cards) {
        cards.style.maxHeight = "";
        cards.style.overflowY = "";
      }
      if (!selectedObjectId || !strip || !tiles) {
        sec.scrollTo({ top: 0 });
        return;
      }

      const viewportH = sec.clientHeight;
      const scrollTop = sec.scrollTop;
      const secTop = sec.getBoundingClientRect().top;
      const tilesTop = tiles.getBoundingClientRect().top - secTop + scrollTop;
      const stripRect = strip.getBoundingClientRect();
      const stripTop = stripRect.top - secTop + scrollTop;

      const topGap = 28;
      const bottomGap = 28;
      const centreScroll = stripTop + stripRect.height / 2 - viewportH / 2;
      const pinScroll = Math.max(0, tilesTop - topGap);
      const target = Math.max(0, Math.min(centreScroll, pinScroll));
      sec.scrollTo({ top: target });

      if (cards) {
        // Measure after the scroll settled, in viewport coords (no scrollTop):
        // scrollTo may have moved us from the pre-scroll `scrollTop`, so reusing
        // it here would overestimate `avail` and let the grid clip below the fold.
        const cardsViewportTop = cards.getBoundingClientRect().top - secTop;
        const avail = viewportH - cardsViewportTop - bottomGap;
        if (cards.scrollHeight > avail + 1 && avail > 120) {
          cards.style.maxHeight = `${Math.floor(avail)}px`;
          cards.style.overflowY = "auto";
          // Pinned: lock the outer scroll so only the card grid scrolls (no
          // double scrollbar). scrollTop stays at the pin we just set.
          sec.style.overflowY = "hidden";
        }
      }
    }

    // Run now (layout is committed; getBoundingClientRect forces sync reflow) and
    // once more after a tick to catch late layout shifts (e.g. web fonts). Avoid
    // requestAnimationFrame — it's paused while the tab is hidden.
    position();
    const timer = setTimeout(position, 60);
    // Observe only the section (viewport). Observing the strip would refire when
    // we cap the card grid's height, creating a feedback loop.
    const observer = new ResizeObserver(() => position());
    observer.observe(section);
    window.addEventListener("resize", position);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [selectedObjectId, selectedChildCount]);

  return (
    <section
      class={`gsv-space${desktopStateClass}`}
      aria-label="GSV desktop"
      onClick={() => {
        onSelectObject(null);
        closeGsvControls();
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

      <div class="gsv-space-scroll" ref={sectionRef}>
        {/* The tree fills the desktop; clicks on its empty space intentionally
            bubble to the section handler to deselect. Interactive children below
            stop propagation so they don't trigger a deselect. */}
        <div class="gsv-space-tree">
          <div
            class="gsv-space-gsv"
            onMouseEnter={openGsvHover}
            onMouseLeave={closeGsvHover}
          >
            <button
              type="button"
              class={`gsv-space-gsv-button${gsvActive ? " is-open" : ""}`}
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

          {gsvActive ? (
            <>
              <span class="gsv-space-control-line" aria-hidden="true" />
              <div
                class="gsv-space-control-popover"
                aria-label="GSV controls"
                onMouseEnter={openGsvHover}
                onMouseLeave={closeGsvHover}
                onClick={(event) => event.stopPropagation()}
              >
                <IconMenu
                  title="GSV // CONTROL"
                  width={386}
                  autoFocus={gsvOpen}
                  onClose={closeGsvControls}
                  onFiles={() => onOpenSurface("files")}
                  onRepositories={() => onOpenSurface("repositories")}
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

              <div ref={tilesRef} class="gsv-space-tiles" style={branchCountStyle(branchCount)}>
                {desktopObjects.map((object) => (
                  <button
                    key={object.id}
                    type="button"
                    class={`gsv-space-tile-button${selectedObjectId === object.id ? " is-selected" : ""}${activeObjectId === object.id ? " is-active" : ""}`}
                    aria-pressed={selectedObjectId === object.id ? "true" : "false"}
                    title={`${object.label}: ${object.meta}, ${object.statusLabel}`}
                    onMouseEnter={() => setHoveredObjectId(object.id)}
                    onMouseLeave={() => setHoveredObjectId((current) => (current === object.id ? null : current))}
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

          {activeObject ? (
            <aside
              ref={stripRef}
              class={`gsv-object-strip${selectedObject ? " is-selected" : " is-preview"}`}
              aria-label={`${activeObject.label} objects`}
              onClick={(event) => event.stopPropagation()}
            >
              <header>
                <strong>
                  <StatusDot tone={activeObject.status} size={7} />
                  {activeObject.statusLabel}
                </strong>
              </header>
              <div ref={cardsRef}>
                {/* No empty state: an object with no children simply shows the
                    "connect new" card below. Messengers always lists Telegram
                    and Discord, so it is never empty. */}
                {activeObject.children.map((child) => (
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
                {canCreateObject(activeObject.id) ? (
                  <div class="gsv-object-strip-add">
                    <AddAction
                      variant="tile"
                      label={addObjectLabel(activeObject.id)}
                      onClick={() => onCreateObject(activeObject.id)}
                    />
                  </div>
                ) : null}
              </div>
            </aside>
          ) : null}
        </div>
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
