import { Component } from "preact";
import type { DesktopApp } from "../domain/desktopApp";
import type { DesktopWindowMode } from "../domain/windowLayout";

export type DesktopWindowView = {
  windowId: string;
  app: DesktopApp;
  route: string;
  title: string;
  badge: string | null;
  dirty: boolean;
  mode: DesktopWindowMode;
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

const RESIZE_DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

type ResizeDirection = typeof RESIZE_DIRECTIONS[number];

type DesktopWindowLayerProps = {
  windows: readonly DesktopWindowView[];
  workspaceWidth: number;
  workspaceHeight: number;
  onWindowMount: (windowId: string, node: HTMLElement | null) => void;
  onContentMount: (windowId: string, node: HTMLElement | null) => void;
  onWindowPointerDown: (windowId: string, event: PointerEvent) => void;
  onWindowClick: (windowId: string, event: MouseEvent) => void;
  onDragPointerDown: (windowId: string, event: PointerEvent) => void;
  onDragDoubleClick: (windowId: string, event: MouseEvent) => void;
  onResizePointerDown: (windowId: string, direction: ResizeDirection, handleNode: HTMLElement, event: PointerEvent) => void;
};

type DesktopWindowContentSlotProps = {
  windowId: string;
  onMount: (windowId: string, node: HTMLElement | null) => void;
};

class DesktopWindowContentSlot extends Component<DesktopWindowContentSlotProps> {
  shouldComponentUpdate(): boolean {
    return false;
  }

  componentWillUnmount(): void {
    this.props.onMount(this.props.windowId, null);
  }

  render({ windowId, onMount }: DesktopWindowContentSlotProps) {
    return (
      <div
        class="window-content"
        data-window-content
        ref={(node) => {
          if (node) {
            onMount(windowId, node);
          }
        }}
      />
    );
  }
}

function windowClassName(window: DesktopWindowView): string {
  const classes = ["mock-window", "managed-window"];
  if (window.active) {
    classes.push("is-active");
  }
  if (window.mode === "maximized") {
    classes.push("is-maximized");
  }
  if (window.dirty) {
    classes.push("is-dirty");
  }
  if (window.badge) {
    classes.push("has-badge");
  }
  return classes.join(" ");
}

function windowStyle(window: DesktopWindowView, workspaceWidth: number, workspaceHeight: number) {
  if (window.mode === "minimized") {
    return {
      zIndex: String(window.zIndex),
      display: "none",
    };
  }

  if (window.mode === "maximized") {
    return {
      zIndex: String(window.zIndex),
      width: `${workspaceWidth}px`,
      height: `${workspaceHeight}px`,
      transform: "translate3d(0px, 0px, 0)",
    };
  }

  return {
    zIndex: String(window.zIndex),
    width: `${window.width}px`,
    height: `${window.height}px`,
    transform: `translate3d(${window.x}px, ${window.y}px, 0)`,
  };
}

export function DesktopWindowLayer({
  windows,
  workspaceWidth,
  workspaceHeight,
  onWindowMount,
  onContentMount,
  onWindowPointerDown,
  onWindowClick,
  onDragPointerDown,
  onDragDoubleClick,
  onResizePointerDown,
}: DesktopWindowLayerProps) {
  return (
    <>
      {windows.map((window) => (
        <section
          key={window.windowId}
          class={windowClassName(window)}
          role="dialog"
          aria-label={window.title === window.app.name ? window.app.name : `${window.title} - ${window.app.name}`}
          hidden={window.mode === "minimized"}
          style={windowStyle(window, workspaceWidth, workspaceHeight)}
          ref={(node) => onWindowMount(window.windowId, node)}
          onPointerDown={(event) => onWindowPointerDown(window.windowId, event)}
          onClick={(event) => onWindowClick(window.windowId, event)}
        >
          <div
            class="window-titlebar"
            data-window-drag-handle
            onPointerDown={(event) => onDragPointerDown(window.windowId, event)}
            onDblClick={(event) => onDragDoubleClick(window.windowId, event)}
          >
            <div class="window-controls">
              <button type="button" class="dot red" data-window-action="close" aria-label="Close window" />
              <button type="button" class="dot amber" data-window-action="minimize" aria-label="Minimize window" />
              <button type="button" class="dot green" data-window-action="maximize" aria-label="Maximize or restore window" />
            </div>
            <span class="window-title">
              <span data-window-title>{window.title}</span>
              <span class="window-dirty-dot" data-window-dirty hidden={!window.dirty} aria-label="Unsaved changes" />
            </span>
            <span class="window-chrome-meta">
              <span class="window-badge" data-window-badge hidden={!window.badge}>{window.badge ?? ""}</span>
              <span class="window-meta" data-window-route>{window.route}</span>
            </span>
          </div>

          <DesktopWindowContentSlot windowId={window.windowId} onMount={onContentMount} />

          {RESIZE_DIRECTIONS.map((direction) => (
            <div
              key={direction}
              class={`window-resize-handle handle-${direction}`}
              data-window-resize={direction}
              onPointerDown={(event) => onResizePointerDown(window.windowId, direction, event.currentTarget, event)}
            />
          ))}
        </section>
      ))}
    </>
  );
}
