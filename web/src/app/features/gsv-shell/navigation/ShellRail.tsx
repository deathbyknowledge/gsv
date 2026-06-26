import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import {
  type DesktopChildObject,
  type DesktopObject,
  type ShellSurfaceId,
} from "../domain/shellModel";

type ShellRailProps = {
  activeSurface: ShellSurfaceId;
  activeTabKey: string | null;
  desktopObjects: readonly DesktopObject[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onBackToDesktop: () => void;
  onOpenControlMenu: () => void;
  onOpenSurface: (surface: ShellSurfaceId) => void;
  onOpenObject: (child: DesktopChildObject) => void;
};

const GLYPH_ICON: Record<string, string> = {
  machines: "computer",
  messengers: "chat",
  integrations: "weblink",
  applications: "stars",
};

/** Drawer id for the GSV system-surfaces section (the one non-object section). */
const GSV_DRAWER = "gsv";

/** Surfaces that belong to the GSV system drawer (FILES/LIBRARY/TERMINAL/SETTINGS).
 *  Note: "settings" also hosts object-detail views, so GSV is only treated as the
 *  active section when no object/data section claims the active route first. */
const GSV_SURFACES: ShellSurfaceId[] = ["files", "library", "terminal", "settings"];

const GSV_RAIL_ITEMS: { label: string; surface: ShellSurfaceId }[] = [
  { label: "FILES", surface: "files" },
  { label: "LIBRARY", surface: "library" },
  { label: "TERMINAL", surface: "terminal" },
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

function GsvMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
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

export function ShellRail({
  activeSurface,
  activeTabKey,
  desktopObjects,
  collapsed,
  onToggleCollapsed,
  onBackToDesktop,
  onOpenControlMenu,
  onOpenSurface,
  onOpenObject,
}: ShellRailProps) {
  const totalObjects = desktopObjects.reduce((sum, object) => sum + object.children.length, 0);

  // The section whose drawer should be open follows the active route: the data
  // section that owns the active surface or active object, else the GSV drawer
  // when a GSV system surface is active.
  const activeSectionId = useMemo<string | null>(() => {
    const section = desktopObjects.find(
      (object) =>
        object.id === activeSurface ||
        object.children.some((child) => childKey(child) === activeTabKey),
    );
    if (section) {
      return section.id;
    }
    if (GSV_SURFACES.includes(activeSurface)) {
      return GSV_DRAWER;
    }
    return null;
  }, [desktopObjects, activeSurface, activeTabKey]);

  // Accordion: exactly one drawer open. It tracks the active section, but the
  // GSV drawer can also be opened manually (GSV is not itself a surface). When
  // navigation moves to a new section, the open drawer follows it (others close).
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  useEffect(() => {
    if (activeSectionId) {
      setOpenDrawer(activeSectionId);
    }
  }, [activeSectionId]);
  const effectiveOpen = openDrawer ?? activeSectionId;

  const isSectionActive = (object: DesktopObject): boolean =>
    activeSurface === object.id ||
    object.children.some((child) => childKey(child) === activeTabKey);
  const gsvActive = activeSectionId === GSV_DRAWER;

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
            class={`gsv-rail-dot-button${activeSurface === object.id ? " is-active" : ""}`}
            title={object.label}
            onClick={() => onOpenSurface(object.id)}
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
                    aria-expanded={object.children.length > 0 ? expanded : undefined}
                    onClick={() => onOpenSurface(object.id)}
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
                  {expanded && object.children.length > 0 ? (
                    <div class="gsv-rail-subitems" aria-label={`${object.label} objects`}>
                      {object.children.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          class={`gsv-rail-subitem${childKey(child) === activeTabKey ? " is-active" : ""}`}
                          title={`${child.label} · ${child.statusLabel}`}
                          onClick={() => onOpenObject(child)}
                        >
                          {child.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
            <button
              type="button"
              class={`gsv-rail-row gsv-rail-gsv${gsvActive ? " is-active" : ""}${effectiveOpen === GSV_DRAWER ? " is-expanded" : ""}`}
              aria-expanded={effectiveOpen === GSV_DRAWER}
              onClick={() => setOpenDrawer(effectiveOpen === GSV_DRAWER ? null : GSV_DRAWER)}
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
                    class={`gsv-rail-subitem${activeSurface === item.surface ? " is-active" : ""}`}
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
