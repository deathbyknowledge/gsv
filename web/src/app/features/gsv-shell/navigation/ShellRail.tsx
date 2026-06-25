import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import {
  type DesktopObject,
  type ShellPageTab,
  type ShellSurfaceId,
} from "../domain/shellModel";

type ShellRailProps = {
  activeSurface: ShellSurfaceId;
  activeTabKey: string | null;
  desktopObjects: readonly DesktopObject[];
  openTabs: readonly ShellPageTab[];
  collapsed: boolean;
  tabsExpanded: boolean;
  onToggleCollapsed: () => void;
  onBackToDesktop: () => void;
  onCloseTab: (key: string) => void;
  onOpenTab: (key: string) => void;
  onOpenTabsPicker: () => void;
  onToggleTabsExpanded: () => void;
  onOpenControlMenu: () => void;
  onOpenSurface: (surface: ShellSurfaceId) => void;
};

const GLYPH_ICON: Record<string, string> = {
  machines: "computer",
  messengers: "chat",
  integrations: "weblink",
  applications: "stars",
};

const GSV_RAIL_ITEMS: { label: string; surface: ShellSurfaceId }[] = [
  { label: "FILES", surface: "files" },
  { label: "LIBRARY", surface: "library" },
  { label: "TERMINAL", surface: "terminal" },
  { label: "SETTINGS", surface: "settings" },
];

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
  openTabs,
  collapsed,
  tabsExpanded,
  onToggleCollapsed,
  onBackToDesktop,
  onCloseTab,
  onOpenTab,
  onOpenTabsPicker,
  onToggleTabsExpanded,
  onOpenControlMenu,
  onOpenSurface,
}: ShellRailProps) {
  const totalObjects = desktopObjects.reduce((sum, object) => sum + object.children.length, 0);
  const tabCount = openTabs.length;
  const hasTabs = tabCount > 0;

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
        {hasTabs ? (
          <button type="button" class="gsv-rail-tabs-dot" title="Open tabs" onClick={onOpenTabsPicker}>
            <Icon name="bookmark" size={17} />
            <span>{tabCount}</span>
          </button>
        ) : null}
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
            {desktopObjects.map((object) => (
              <button
                key={object.id}
                type="button"
                class={`gsv-rail-row${activeSurface === object.id ? " is-active" : ""}`}
                title={`${object.label}: ${object.meta}, ${object.statusLabel}`}
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
            ))}
            <button
              type="button"
              class="gsv-rail-row gsv-rail-gsv is-active"
              onClick={onOpenControlMenu}
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
          </div>
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
        </div>
      </div>

      <footer>DRAG CHAT &lt;- TO EXPAND</footer>
      {hasTabs ? (
        <div class="gsv-rail-tabs">
          <button
            type="button"
            class="gsv-rail-tabs-head"
            onClick={onToggleTabsExpanded}
          >
            <span class="gsv-rail-tabs-icon"><Icon name="bookmark" size={15} /></span>
            <span>TABS</span>
            <small>{tabCount}</small>
          </button>
          {tabsExpanded ? (
            <div class="gsv-rail-tabs-list">
              {openTabs.map((tab) => {
                const active = tab.key === activeTabKey;
                return (
                  <div class={`gsv-rail-tab-row${active ? " is-active" : ""}`} key={tab.key}>
                    <button type="button" onClick={() => onOpenTab(tab.key)}>
                      <span class="gsv-rail-tab-icon">
                        <Icon name="bookmark" size={17} />
                      </span>
                      <span>{tab.title}</span>
                    </button>
                    <button
                      type="button"
                      class="gsv-rail-tab-close"
                      title={`Close ${tab.title}`}
                      aria-label={`Close ${tab.title}`}
                      onClick={() => onCloseTab(tab.key)}
                    >
                      x
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
