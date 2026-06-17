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
