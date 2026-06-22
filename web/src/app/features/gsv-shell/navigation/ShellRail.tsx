import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import {
  GSV_CONTROL_ITEMS,
  type DesktopObject,
  type DesktopObjectId,
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
  onOpenSurface: (surface: "files" | "library" | "terminal" | "settings") => void;
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
            <span style={{ background: statusColor(object.status) }} />
            <small>{object.children.length}</small>
          </button>
        ))}
        <button type="button" class="gsv-rail-gsv-dot" title="GSV" onClick={onToggleCollapsed}>
          <GsvMark />
        </button>
        {tabs.length > 0 ? (
          <button
            type="button"
            class="gsv-rail-tabs-dot"
            title="Open tabs"
            onClick={() => onSetRailMode("tabs")}
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

      <div class="gsv-rail-scroll">
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
                <small>{object.meta}</small>
              </span>
              <i style={{ background: statusColor(object.status) }} />
            </button>
          ))}
          <button
            type="button"
            class={`gsv-rail-row gsv-rail-gsv${railMode === "gsv" ? " is-active" : ""}`}
            onClick={() => onSetRailMode(railMode === "gsv" ? "tabs" : "gsv")}
          >
            <span class="gsv-rail-node-icon">
              <GsvMark />
            </span>
            <span class="gsv-rail-row-copy">
              <span>GSV</span>
              <small>systems</small>
            </span>
          </button>
        </div>

        {railMode === "gsv" ? (
          <nav class="gsv-rail-subnav" aria-label="GSV systems">
            {GSV_CONTROL_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                class={activeTabKey === item.id ? "is-active" : ""}
                onClick={() => onOpenSurface(item.id)}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        ) : null}

        {tabs.length > 0 ? (
          <section class="gsv-rail-tabs" aria-label="Open tabs">
            <button
              type="button"
              class={`gsv-rail-tabs-head${railMode === "tabs" ? " is-active" : ""}`}
              onClick={() => onSetRailMode("tabs")}
            >
              <Icon name="bookmark" size={15} />
              <span>TABS</span>
              <small>{tabs.length}</small>
            </button>
            {railMode === "tabs" ? (
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
            ) : null}
          </section>
        ) : null}
      </div>

      <footer>drag chat left to collapse</footer>
    </aside>
  );
}
