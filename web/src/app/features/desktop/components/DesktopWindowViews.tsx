import type { DesktopApp } from "../domain/desktopApp";

type DesktopWindowFrameProps = {
  app: DesktopApp;
  route: string;
};

const RESIZE_DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

export function DesktopWindowFrame({
  app,
  route,
}: DesktopWindowFrameProps) {
  return (
    <>
      <div class="window-titlebar" data-window-drag-handle>
        <div class="window-controls">
          <button type="button" class="dot red" data-window-action="close" aria-label="Close window" />
          <button type="button" class="dot amber" data-window-action="minimize" aria-label="Minimize window" />
          <button type="button" class="dot green" data-window-action="maximize" aria-label="Maximize or restore window" />
        </div>
        <span class="window-title">
          <span data-window-title>{app.name}</span>
          <span class="window-dirty-dot" data-window-dirty hidden aria-label="Unsaved changes" />
        </span>
        <span class="window-chrome-meta">
          <span class="window-badge" data-window-badge hidden />
          <span class="window-meta" data-window-route>{route}</span>
        </span>
      </div>

      <div class="window-content" data-window-content />

      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          class={`window-resize-handle handle-${direction}`}
          data-window-resize={direction}
        />
      ))}
    </>
  );
}
