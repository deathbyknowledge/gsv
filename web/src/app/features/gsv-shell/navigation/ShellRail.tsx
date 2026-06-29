import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { GsvMark } from "../../../components/ui/GsvMark";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
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
  onToggleCollapsed: () => void;
  onBackToDesktop: () => void;
  onOpenControlMenu: () => void;
  onOpenSurface: (surface: ShellSurfaceId) => void;
  onOpenObject: (child: DesktopChildObject) => void;
  onCreateObject: (section: DesktopObjectId) => void;
};

const GLYPH_ICON: Record<string, string> = {
  machines: "computer",
  messengers: "chat",
  integrations: "weblink",
  applications: "satellite",
};

/** Sections that show a "create" entry in their drawer. The label is the same
 *  for every section. Messengers are intentionally absent — connecting a
 *  messenger is done from its dedicated platform page. Applications are absent —
 *  they route to the applications list page instead of a drawer. */
const CREATE_LABEL: Record<string, string> = {
  machines: "+ CONNECT NEW",
  integrations: "+ CONNECT NEW",
};

/** Drawer id for the GSV system-surfaces section (the one non-object section). */
const GSV_DRAWER = "gsv";

/** Unambiguous GSV system surfaces. "settings" is handled separately because it
 *  is overloaded (crew/tasks/config/object-detail all route through it). */
const GSV_PLAIN_SURFACES: ShellSurfaceId[] = ["files", "repositories", "library", "terminal"];

const GSV_RAIL_ITEMS: { label: string; surface: ShellSurfaceId }[] = [
  { label: "FILES", surface: "files" },
  { label: "LIBRARY", surface: "library" },
  { label: "TERMINAL", surface: "terminal" },
  { label: "REPOS", surface: "repositories" },
  { label: "SETTINGS", surface: "settings" },
];

/** Stable tab key for an object child — mirrors shellTabForDesktopChild so the
 *  rail can match the active tab against a child without importing the factory. */
function childKey(child: DesktopChildObject): string {
  return `obj:${child.route.kind}:${child.route.detailId}`;
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
  onToggleCollapsed,
  onBackToDesktop,
  onOpenControlMenu,
  onOpenSurface,
  onOpenObject,
  onCreateObject,
}: ShellRailProps) {
  const totalObjects = desktopObjects.reduce((sum, object) => sum + object.children.length, 0);

  // A settings list/detail route surfaces as activeSurface="settings" with a
  // generic activeTabKey, so re-derive the object key it points at (matching
  // childKey's `obj:<kind>:<detailId>` shape) to keep the owning drawer + the
  // specific subitem lit when reached via settings nav.
  const settingsObjectKey = settingsKind && settingsDetailId
    ? `obj:${settingsKind}:${settingsDetailId}`
    : null;
  const ownsActiveObject = (object: DesktopObject): boolean =>
    object.id === activeSurface ||
    object.id === createSection ||
    object.id === settingsKind ||
    object.children.some((child) => {
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
    // belongs to the GSV drawer, which then lights its SETTINGS subitem.
    if (activeSurface === "settings") {
      return GSV_DRAWER;
    }
    return null;
  }, [desktopObjects, activeSurface, activeTabKey, settingsView, createSection, settingsKind, settingsObjectKey]);

  // Accordion: exactly one drawer open, derived purely from the active route.
  // GSV is the only drawer that opens without navigating (it is not a surface),
  // so a manual toggle overrides the route-following selection until the active
  // section next changes.
  const [gsvManualOpen, setGsvManualOpen] = useState(false);
  useEffect(() => {
    setGsvManualOpen(false);
  }, [activeSectionId]);
  const effectiveOpen = gsvManualOpen ? GSV_DRAWER : activeSectionId;

  const isSectionActive = ownsActiveObject;
  const gsvActive = activeSectionId === GSV_DRAWER;

  // Shared by both the expanded rows and the collapsed icon dots so collapsed
  // navigation follows the same per-object flow.
  const openSection = (object: DesktopObject): void => {
    if (isSectionActive(object)) {
      return; // already in this section — leave the current object alone
    }
    // Applications open as native app frames — jarring to launch from a section
    // click — so route to the applications list page instead of auto-opening
    // one. Empty sections also go to their landing.
    if (object.id === "applications" || object.children.length === 0) {
      onOpenSurface(object.id);
      return;
    }
    onOpenObject(object.children[0]); // auto-open the first object
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
            onClick={() => openSection(object)}
          >
            <Icon name={GLYPH_ICON[object.glyph]} size={19} />
            <span class="gsv-rail-status-dot" style={{ background: statusColor(object.status), color: statusColor(object.status) }} />
          </button>
        ))}
        <button type="button" class="gsv-rail-gsv-dot" title="GSV controls" onClick={onOpenControlMenu}>
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
          <small>GSV · {totalObjects} objects</small>
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
                        <Icon name={GLYPH_ICON[object.glyph]} size={19} />
                      </span>
                    </span>
                    <span class="gsv-rail-row-copy">
                      <span>{object.label}</span>
                    </span>
                    <i style={{ background: statusColor(object.status), color: statusColor(object.status) }} />
                  </button>
                  {expanded && object.id !== "applications" ? (
                    <div class="gsv-rail-subitems" aria-label={`${object.label} objects`}>
                      {object.children.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          class={`gsv-rail-subitem${childKey(child) === activeTabKey || childKey(child) === settingsObjectKey ? " is-active" : ""}`}
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
              onClick={() => setGsvManualOpen((open) => !open)}
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
                {GSV_RAIL_ITEMS.map((item) => (
                  <button
                    key={item.surface}
                    type="button"
                    class={`gsv-rail-subitem${gsvActive && activeSurface === item.surface ? " is-active" : ""}`}
                    onClick={() => onOpenSurface(item.surface)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <footer>DRAG CHAT &lt;- TO EXPAND</footer>
    </aside>
  );
}
