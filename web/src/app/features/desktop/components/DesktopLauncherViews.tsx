import type { AppIcon, AppManifest } from "../../../../apps";
import type { WindowSummary } from "../runtime/windowManager";

type DesktopAppIconsProps = {
  apps: readonly AppManifest[];
  activeAppId: string | null;
  selectedAppId: string | null;
};

type TaskbarWindowsProps = {
  summaries: readonly WindowSummary[];
};

type CommandPaletteItem = {
  id: string;
  label: string;
  meta: string;
  icon: string;
};

type CommandPaletteItemsProps = {
  items: readonly CommandPaletteItem[];
  selectedIndex: number;
};

type MobileAppGridProps = {
  apps: readonly AppManifest[];
};

type MobileWindowStackProps = {
  summaries: readonly WindowSummary[];
};

function iconClassName(appId: string, activeAppId: string | null, selectedAppId: string | null): string {
  const classes = ["desktop-icon"];
  if (appId === activeAppId) {
    classes.push("is-active");
  }
  if (appId === selectedAppId) {
    classes.push("is-selected");
  }
  return classes.join(" ");
}

function taskbarClassName(summary: WindowSummary): string {
  const classes = ["taskbar-window"];
  if (summary.mode === "minimized") {
    classes.push("is-minimized");
  }
  if (summary.active) {
    classes.push("is-active");
  }
  return classes.join(" ");
}

function DesktopAppIconGlyph({ icon }: { icon: AppIcon }) {
  if (icon.kind === "svg") {
    return (
      <span
        class="desktop-glyph is-package-svg"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: icon.svg }}
      />
    );
  }

  return (
    <span class="desktop-glyph is-fallback" aria-hidden="true">
      <span>{icon.label}</span>
    </span>
  );
}

function mobileWindowLayerClassName(summary: WindowSummary, index: number): string {
  const classes = ["mobile-window-layer"];
  if (index === 0) {
    classes.push("is-front-window");
  }
  if (summary.mode !== "minimized") {
    classes.push("is-visible-window");
  }
  if (summary.active && summary.mode !== "minimized") {
    classes.push("is-active-window");
  }
  if (summary.mode === "minimized") {
    classes.push("is-paused-window");
  }
  return classes.join(" ");
}

function mobileWindowLayerStyle(summary: WindowSummary, index: number) {
  const pausedDepth = summary.mode === "minimized" ? 1 : 0;
  const depthIndex = index + pausedDepth;

  return {
    "--window-depth-index": String(index),
    "--window-depth-x": `${18 + depthIndex * 9}px`,
    "--window-depth-y": `${16 + depthIndex * 8}px`,
    "--window-depth-z": `${depthIndex * -42}px`,
    "--window-depth-scale": Math.max(0.74, 1 - depthIndex * 0.055).toFixed(3),
    "--window-layer-opacity": (summary.mode === "minimized" ? Math.max(0.24, 0.62 - index * 0.1) : Math.max(0.44, 0.95 - index * 0.12)).toFixed(3),
    "--window-depth-compact-x": `${12 + depthIndex * 5}px`,
    "--window-depth-compact-y": `${14 + depthIndex * 7}px`,
    "--window-layer-z-index": String(20 - index),
  };
}

export function DesktopAppIcons({
  apps,
  activeAppId,
  selectedAppId,
}: DesktopAppIconsProps) {
  return (
    <>
      {apps.map((app) => (
        <button
          key={app.id}
          type="button"
          class={iconClassName(app.id, activeAppId, selectedAppId)}
          data-app-id={app.id}
        >
          <DesktopAppIconGlyph icon={app.icon} />
          <span class="desktop-label">{app.name}</span>
        </button>
      ))}
    </>
  );
}

export function MobileAppGrid({ apps }: MobileAppGridProps) {
  return (
    <>
      {apps.map((app) => (
        <button
          key={app.id}
          type="button"
          class="mobile-app-icon"
          data-app-id={app.id}
        >
          <DesktopAppIconGlyph icon={app.icon} />
          <span class="mobile-app-copy">
            <strong>{app.name}</strong>
            <small>{app.description}</small>
          </span>
          <span class="mobile-window-stack" data-mobile-window-stack aria-hidden="true" />
        </button>
      ))}
    </>
  );
}

export function MobileWindowStack({ summaries }: MobileWindowStackProps) {
  return (
    <>
      {summaries.map((summary, index) => (
        <span
          key={summary.windowId}
          class={mobileWindowLayerClassName(summary, index)}
          data-window-id={summary.windowId}
          style={mobileWindowLayerStyle(summary, index)}
        >
          <span class="mobile-window-layer-title">{summary.title}</span>
        </span>
      ))}
    </>
  );
}

export function TaskbarWindows({ summaries }: TaskbarWindowsProps) {
  return (
    <>
      {summaries
        .slice()
        .sort((left, right) => right.zIndex - left.zIndex)
        .map((summary) => (
          <button
            key={summary.windowId}
            type="button"
            class={taskbarClassName(summary)}
            data-window-id={summary.windowId}
            title={`${summary.title} - ${summary.route}`}
          >
            <span class="taskbar-window-title">{summary.title}</span>
            {summary.dirty ? <span class="taskbar-dirty" aria-label="Unsaved changes" /> : null}
            {summary.badge ? <span class="taskbar-badge">{summary.badge}</span> : null}
          </button>
        ))}
    </>
  );
}

export function CommandPaletteItems({
  items,
  selectedIndex,
}: CommandPaletteItemsProps) {
  if (items.length === 0) {
    return <li class="command-palette-empty">No results</li>;
  }

  return (
    <>
      {items.map((item, index) => (
        <li key={item.id}>
          <button
            type="button"
            class={index === selectedIndex ? "command-palette-item is-active" : "command-palette-item"}
            data-command-index={index}
          >
            <span
              class="command-palette-icon"
              dangerouslySetInnerHTML={{ __html: item.icon }}
            />
            <span class="command-palette-label">{item.label}</span>
            <small>{item.meta}</small>
          </button>
        </li>
      ))}
    </>
  );
}
