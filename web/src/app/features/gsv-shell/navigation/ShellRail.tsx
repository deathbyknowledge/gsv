import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import {
  type DesktopObject,
  type DesktopObjectId,
} from "../domain/shellModel";

type ShellRailProps = {
  desktopObjects: readonly DesktopObject[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onBackToDesktop: () => void;
  onOpenPicker: (id: DesktopObjectId) => void;
  onOpenControlMenu: () => void;
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
  onToggleCollapsed,
  onBackToDesktop,
  onOpenPicker,
  onOpenControlMenu,
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
              <GsvMark />
            </span>
            <span class="gsv-rail-row-copy">
              <span>GSV</span>
            </span>
          </button>
        </div>
      </div>

      <footer>DRAG CHAT &lt;- TO EXPAND</footer>
    </aside>
  );
}
