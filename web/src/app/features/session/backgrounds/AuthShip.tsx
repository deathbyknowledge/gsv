import { useMemo, useRef } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import type { ColorTheme } from "../../../components/ui/useColorTheme";
import { createShipScene } from "./ship/shipScene";
import "./AuthShip.css";

export function AuthShip({ theme, compact = false }: { theme: ColorTheme; compact?: boolean }) {
  const scene = useMemo(createShipScene, []);
  const drag = useRef<{ id: number; x: number; y: number; width: number } | null>(null);
  return <div class={`gsv-auth-illustration${compact ? " is-compact" : ""}`} tabIndex={0} role="group"
    aria-label="Your Ship. Drag to turn. Arrow keys turn; Home resets."
    aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home"
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "true";
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: event.currentTarget.getBoundingClientRect().width };
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.id !== event.pointerId) return;
      scene.turn((event.clientX - active.x) / active.width * Math.PI * 2, (event.clientY - active.y) / active.width * Math.PI * 2);
      active.x = event.clientX; active.y = event.clientY;
    }}
    onLostPointerCapture={(event) => { drag.current = null; delete event.currentTarget.dataset.dragging; }}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") scene.reset();
      else scene.turn(event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0,
        event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0);
    }}>
    <AsciiAnimation scene={scene} label="Your Ship" palette={theme} frameRate={18} className="gsv-auth-ship" />
  </div>;
}
