import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import {
  GSV_CONTROL_ITEMS,
  type DesktopObject,
  type DesktopObjectId,
  type GsvControlItem,
  type ShellRailMode,
  type ShellTab,
} from "../domain/shellModel";

type ShellRailProps = {
  desktopObjects: readonly DesktopObject[];
  collapsed: boolean;
  railMode: ShellRailMode;
  tabs: readonly ShellTab[];
  activeTabKey: string | null;
  onToggleCollapsed: () => void;
  onSetRailMode: (mode: ShellRailMode) => void;
  onBackToDesktop: () => void;
  onOpenPicker: (id: DesktopObjectId) => void;
  onOpenControlMenu: () => void;
  onOpenSurface: (surface: GsvControlItem["id"]) => void;
  onActivateTab: (key: string) => void;
  onCloseTab: (key: string) => void;
};

const GLYPH_ICON: Record<string, string> = {
  machines: "computer",
  messengers: "chat",
  integrations: "weblink",
  applications: "stars",
};

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
  desktopObjects,
  collapsed,
  railMode,
  tabs,
  activeTabKey,
  onToggleCollapsed,
  onSetRailMode,
  onBackToDesktop,
  onOpenPicker,
  onOpenControlMenu,
  onOpenSurface,
  onActivateTab,
  onCloseTab,
}: ShellRailProps) {
  const totalObjects = desktopObjects.reduce((sum, object) => sum + object.children.length, 0);

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
            class="gsv-rail-dot-button"
            title={object.label}
            onClick={() => onOpenPicker(object.id)}
          >
            <Icon name={GLYPH_ICON[object.glyph]} size={19} />
            <span style={{ background: statusColor(object.status), color: statusColor(object.status) }} />
          </button>
        ))}
        <button type="button" class="gsv-rail-gsv-dot" title="GSV controls" onClick={onOpenControlMenu}>
          <GsvMark />
        </button>
        {tabs.length > 0 ? (
          <button
            type="button"
            class="gsv-rail-tabs-dot"
            title="Open tabs"
            onClick={() => {
              onSetRailMode("tabs");
              onToggleCollapsed();
            }}
          >
            <Icon name="bookmark" size={18} />
            <strong>{tabs.length}</strong>
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

      <div class="gsv-rail-modes" role="tablist" aria-label="Rail mode">
        <button
          type="button"
          role="tab"
          aria-selected={railMode === "objects" ? "true" : "false"}
          class={railMode === "objects" ? "is-active" : ""}
          onClick={() => onSetRailMode("objects")}
        >
          <Icon name="stars" size={13} />
          <span>OBJECTS</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={railMode === "gsv" ? "true" : "false"}
          class={railMode === "gsv" ? "is-active" : ""}
          onClick={() => onSetRailMode("gsv")}
        >
          <GsvMark size={15} />
          <span>GSV</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={railMode === "tabs" ? "true" : "false"}
          class={railMode === "tabs" ? "is-active" : ""}
          disabled={tabs.length === 0}
          onClick={() => onSetRailMode("tabs")}
        >
          <Icon name="bookmark" size={13} />
          <span>TABS</span>
          {tabs.length > 0 ? <small>{tabs.length}</small> : null}
        </button>
      </div>

      <div class="gsv-rail-scroll">
        {railMode === "objects" ? (
          <div class="gsv-rail-tree">
            <span class="gsv-rail-spine" aria-hidden="true" />
            {desktopObjects.map((object) => (
              <button
                key={object.id}
                type="button"
                class="gsv-rail-row"
                title={`${object.label}: ${object.meta}, ${object.statusLabel}`}
                onClick={() => onOpenPicker(object.id)}
              >
                <span class="gsv-rail-node-icon">
                  <Icon name={GLYPH_ICON[object.glyph]} size={19} />
                </span>
                <span class="gsv-rail-row-copy">
                  <span>{object.label}</span>
                </span>
                <i style={{ background: statusColor(object.status), color: statusColor(object.status) }} />
              </button>
            ))}
          </div>
        ) : null}

        {railMode === "gsv" ? (
          <nav class="gsv-rail-subnav" aria-label="GSV systems">
            <button type="button" class="gsv-rail-control-menu" onClick={onOpenControlMenu}>
              <span class="gsv-rail-subnav-icon">
                <GsvMark size={16} />
              </span>
              <span>CONTROL MENU</span>
            </button>
            {GSV_CONTROL_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                class={activeTabKey === item.id ? "is-active" : ""}
                onClick={() => onOpenSurface(item.id)}
              >
                <span class="gsv-rail-subnav-icon">
                  <Icon name={item.icon} size={14} />
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        ) : null}

        {tabs.length > 0 && railMode === "tabs" ? (
          <section class="gsv-rail-tabs" aria-label="Open tabs">
            <div class="gsv-rail-tabs-head is-active">
              <Icon name="bookmark" size={15} />
              <span>TABS</span>
              <small>{tabs.length}</small>
            </div>
            <div class="gsv-rail-tab-list">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  class={tab.key === activeTabKey ? "is-active" : ""}
                  onClick={() => onActivateTab(tab.key)}
                >
                  <span class="gsv-rail-tab-icon">
                    <Icon name="bookmark" size={13} />
                  </span>
                  <span>{tab.title}</span>
                  <i
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.key);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        onCloseTab(tab.key);
                      }
                    }}
                  >
                    x
                  </i>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <footer>LIVE SHELL</footer>
    </aside>
  );
}
