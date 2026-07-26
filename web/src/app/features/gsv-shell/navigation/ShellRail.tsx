import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { GsvMark } from "../../../components/ui/GsvMark";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { OBJECT_GLYPH_ICON, type ObjectGlyph } from "../../../components/ui/objectGlyph";
import {
  type DesktopChildObject,
  type DesktopObject,
  type DesktopObjectId,
  type ShellSurfaceId,
} from "../domain/shellModel";

type ShellRailProps = {
  activeSurface: ShellSurfaceId;
  activeTabKey: string | null;
  /** view of the active settings route — distinguishes the GSV Settings surface
   *  from crew/tasks/config/object views that also live on "settings". */
  settingsView: string;
  /** section whose create flow is active, so its drawer stays open and its
   *  create entry stays selected (the create route has no object child). */
  createSection: string | null;
  /** Owning section + object for a settings list/detail route (e.g. a direct
   *  URL to settings?kind=machines&detailId=…, or a detail page's BACK TO X).
   *  These surface as activeSurface="settings"/activeTabKey="settings", so the
   *  rail needs the route kind/detail to keep the right drawer + subitem lit. */
  settingsKind: string | null;
  settingsDetailId: string | null;
  desktopObjects: readonly DesktopObject[];
  collapsed: boolean;
  /** Whether expanding is currently possible — false while width pressure
   *  auto-collapses the rail. Collapsed icon clicks then navigate instead of
   *  revealing a drawer that cannot appear. */
  canExpand: boolean;
  onToggleCollapsed: () => void;
  onBackToDesktop: () => void;
  onOpenSurface: (surface: ShellSurfaceId) => void;
  onOpenObject: (child: DesktopChildObject) => void;
  onCreateObject: (section: DesktopObjectId) => void;
};


/** Sections that show a "create" entry in their drawer. The rail keeps the
 *  untyped label (the section provides the type; typed labels wrap at rail
 *  width). Messengers are intentionally absent — connecting a messenger is
 *  done from its dedicated platform page. */
const CREATE_LABEL: Record<string, string> = {
  machines: "+ CONNECT NEW",
  integrations: "+ CONNECT NEW",
  applications: "+ CONNECT NEW",
};

/** Drawer id for the GSV ship section (the one non-object section). */
const GSV_DRAWER = "gsv";

/** Unambiguous GSV ship surfaces. "settings" is handled separately because it
 *  is overloaded (config/object-detail routes also travel through it); "agent"
 *  is here so the AGENTS item stays lit while drilled into an agent. */
const GSV_PLAIN_SURFACES: ShellSurfaceId[] = ["crew", "agent", "runtime", "models"];

const GSV_RAIL_ITEMS: { label: string; surface: ShellSurfaceId }[] = [
  { label: "OVERVIEW", surface: "settings" },
  { label: "AGENTS", surface: "crew" },
  { label: "MODELS", surface: "models" },
  { label: "TASKS", surface: "runtime" },
];

/** Stable key for a drawer subitem — mirrors shellTabForDesktopChild for
 *  object children; native children key off the surface they open. */
function childKey(child: DesktopChildObject): string {
  if (child.surface) {
    return `native:${child.surface}`;
  }
  return child.route ? `obj:${child.route.kind}:${child.route.detailId}` : child.id;
}

function statusColor(status: string): string {
  if (status === "error") {
    return "var(--error)";
  }
  if (status === "idle") {
    return "var(--idle)";
  }
  if (status === "warn" || status === "update") {
    return "var(--update)";
  }
  if (status === "live") {
    return "var(--live)";
  }
  return "var(--online)";
}

export function ShellRail({
  activeSurface,
  activeTabKey,
  settingsView,
  createSection,
  settingsKind,
  settingsDetailId,
  desktopObjects,
  collapsed,
  canExpand,
  onToggleCollapsed,
  onBackToDesktop,
  onOpenSurface,
  onOpenObject,
  onCreateObject,
}: ShellRailProps) {

  // A settings list/detail route surfaces as activeSurface="settings" with a
  // generic activeTabKey, so re-derive the object key it points at (matching
  // childKey's `obj:<kind>:<detailId>` shape) to keep the owning drawer + the
  // specific subitem lit when reached via settings nav.
  const settingsObjectKey = settingsKind && settingsDetailId
    ? `obj:${settingsKind}:${settingsDetailId}`
    : null;
  // Native subitems light by the surface they open; object subitems by tab key.
  const childIsActive = (child: DesktopChildObject): boolean => {
    if (child.surface) {
      return child.surface === activeSurface;
    }
    const key = childKey(child);
    return key === activeTabKey || key === settingsObjectKey;
  };
  const ownsActiveObject = (object: DesktopObject): boolean =>
    object.id === activeSurface ||
    object.id === createSection ||
    object.id === settingsKind ||
    object.children.some((child) => {
      if (child.surface) {
        return child.surface === activeSurface;
      }
      const key = childKey(child);
      return key === activeTabKey || key === settingsObjectKey;
    });

  // The section whose drawer should be open follows the active route: the data
  // section that owns the active surface or active object, else the GSV drawer
  // when a GSV system surface is active.
  const activeSectionId = useMemo<string | null>(() => {
    const section = desktopObjects.find(ownsActiveObject);
    if (section) {
      return section.id;
    }
    if (GSV_PLAIN_SURFACES.includes(activeSurface)) {
      return GSV_DRAWER;
    }
    // Any "settings" route not owned by a data section above (overview, crew,
    // agent, config, and tasks/library lists whose kind is not a data object)
    // belongs to the GSV drawer, which then lights its SHIP OVERVIEW subitem.
    if (activeSurface === "settings") {
      return GSV_DRAWER;
    }
    return null;
  }, [desktopObjects, activeSurface, activeTabKey, settingsView, createSection, settingsKind, settingsObjectKey]);

  // Accordion: exactly one drawer open, derived from the active route — except
  // right after a collapsed icon click, which expands the rail and reveals that
  // section's drawer WITHOUT navigating. The manual pick overrides the
  // route-following selection until the active section next changes.
  const [manualSection, setManualSection] = useState<string | null>(null);
  useEffect(() => {
    setManualSection(null);
  }, [activeSectionId]);
  const effectiveOpen = manualSection ?? activeSectionId;

  const isSectionActive = ownsActiveObject;
  const gsvActive = activeSectionId === GSV_DRAWER;

  // Expanded rail: a main row navigates to its section's list page. Drilling
  // into a specific object is done from the list itself or the drawer
  // subitems — never by auto-opening the first child on a section click.
  const openSection = (object: DesktopObject): void => {
    if (isSectionActive(object)) {
      return; // already in this section — leave the current object alone
    }
    onOpenSurface(object.id);
  };

  // Collapsed rail: an icon click expands the rail and reveals that section's
  // drawer (no navigation). When width pressure keeps the rail collapsed,
  // expanding is impossible, so fall back to navigating.
  const revealSection = (drawerId: string, fallback: () => void): void => {
    if (!canExpand) {
      fallback();
      return;
    }
    setManualSection(drawerId);
    onToggleCollapsed();
  };

  if (collapsed) {
    return (
      <aside class="gsv-shell-rail is-collapsed" aria-label="GSV navigation">
        <span class="gsv-rail-menu">
          <IconButton glyph="menu" size="medium" title="Show menu" onClick={onToggleCollapsed} />
        </span>
        <span class="gsv-rail-rule" aria-hidden="true" />
        {desktopObjects.map((object) => (
          <button
            key={object.id}
            type="button"
            class={`gsv-rail-dot-button${isSectionActive(object) ? " is-active" : ""}`}
            title={object.label}
            onClick={() => revealSection(object.id, () => openSection(object))}
          >
            <Icon name={OBJECT_GLYPH_ICON[object.glyph as ObjectGlyph]} size={19} />
            <span class="gsv-rail-status-dot" style={{ background: statusColor(object.status), color: statusColor(object.status) }} />
          </button>
        ))}
        <button
          type="button"
          class="gsv-rail-gsv-dot"
          title="GSV"
          onClick={() => revealSection(GSV_DRAWER, () => onOpenSurface("settings"))}
        >
          <GsvMark />
        </button>
      </aside>
    );
  }

  return (
    <aside class="gsv-shell-rail" aria-label="GSV navigation">
      <header class="gsv-rail-head">
        <button type="button" class="gsv-rail-home" onClick={onBackToDesktop}>
          <span>DESKTOP // GSV</span>
        </button>
        <span class="gsv-rail-menu">
          <IconButton glyph="menu" size="small" title="Hide menu" onClick={onToggleCollapsed} />
        </span>
      </header>

      <div class="gsv-rail-scroll">
        <div class="gsv-rail-tree">
          <div class="gsv-rail-primary-tree">
            <span class="gsv-rail-spine" aria-hidden="true" />
            {desktopObjects.map((object) => {
              const expanded = effectiveOpen === object.id;
              return (
                <Fragment key={object.id}>
                  <button
                    type="button"
                    class={`gsv-rail-row${isSectionActive(object) ? " is-active" : ""}${expanded ? " is-expanded" : ""}`}
                    title={`${object.label}: ${object.meta}, ${object.statusLabel}`}
                    aria-expanded={expanded}
                    onClick={() => openSection(object)}
                  >
                    <span class="gsv-rail-node-icon">
                      <span class="gsv-rail-node-disc">
                        <Icon name={OBJECT_GLYPH_ICON[object.glyph as ObjectGlyph]} size={19} />
                      </span>
                    </span>
                    <span class="gsv-rail-row-copy">
                      <span>{object.label}</span>
                    </span>
                    <i style={{ background: statusColor(object.status), color: statusColor(object.status) }} />
                  </button>
                  {expanded ? (
                    <div class="gsv-rail-subitems" aria-label={`${object.label} objects`}>
                      {object.children.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          class={`gsv-rail-subitem${childIsActive(child) ? " is-active" : ""}`}
                          title={`${child.label} · ${child.statusLabel}`}
                          onClick={() => onOpenObject(child)}
                        >
                          {child.label}
                        </button>
                      ))}
                      {CREATE_LABEL[object.id] ? (
                        <button
                          type="button"
                          class={`gsv-rail-subitem gsv-rail-subitem-create${object.id === createSection ? " is-active" : ""}`}
                          onClick={() => onCreateObject(object.id)}
                        >
                          {CREATE_LABEL[object.id]}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
            <button
              type="button"
              class={`gsv-rail-row gsv-rail-gsv${gsvActive ? " is-active" : ""}${effectiveOpen === GSV_DRAWER ? " is-expanded" : ""}`}
              aria-expanded={effectiveOpen === GSV_DRAWER}
              onClick={() => {
                // Like the object rows, the GSV row navigates to its page —
                // the ship overview. The drawer follows the route (settings
                // routes are owned by the GSV drawer).
                if (activeSurface !== "settings" || settingsView !== "overview") {
                  onOpenSurface("settings");
                }
              }}
            >
              <span class="gsv-rail-node-icon">
                <span class="gsv-rail-node-disc is-gsv">
                  <GsvMark />
                </span>
              </span>
              <span class="gsv-rail-row-copy">
                <span>GSV</span>
              </span>
            </button>
            {effectiveOpen === GSV_DRAWER ? (
              <div class="gsv-rail-subitems" aria-label="GSV system surfaces">
                {GSV_RAIL_ITEMS.map((item) => {
                  // AGENTS keeps its highlight while drilled into an agent detail.
                  const itemActive = gsvActive
                    && (activeSurface === item.surface
                      || (item.surface === "crew" && activeSurface === "agent"));
                  return (
                    <button
                      key={item.surface}
                      type="button"
                      class={`gsv-rail-subitem${itemActive ? " is-active" : ""}`}
                      onClick={() => onOpenSurface(item.surface)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <footer>DRAG CHAT &lt;- TO EXPAND</footer>
    </aside>
  );
}
