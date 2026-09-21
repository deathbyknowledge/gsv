import { memo } from "preact/compat";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { AsciiAnimation } from "../../components/ui/AsciiAnimation";
import { useColorTheme } from "../../components/ui/useColorTheme";
import { createGestureScene, GESTURE_FRAME_RATE, type GestureLesson } from "./gestureScene";

export const GestureIllustration = memo(function GestureIllustration({ lesson, label }: { lesson: GestureLesson; label: string }) {
  const [paused, setPaused] = useState(false);
  const { theme } = useColorTheme();
  const scene = useMemo(() => createGestureScene(lesson), [lesson]);
  const viewer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const endDrag = (event?: PointerEvent) => {
    const active = drag.current;
    if (!active || (event && event.pointerId !== active.pointer)) return;
    drag.current = null;
    const element = viewer.current;
    if (element) {
      delete element.dataset.dragging;
      if (element.hasPointerCapture(active.pointer)) element.releasePointerCapture(active.pointer);
    }
    scene.endTurn();
  };
  useLayoutEffect(() => () => { endDrag(); }, [scene]);
  return <figure class="native-gesture-example">
      <div ref={viewer} class="native-gesture-viewer" role="group" tabIndex={0}
        aria-label="Hand model. Drag horizontally or use Left and Right to turn; Home resets the angle."
        aria-keyshortcuts="ArrowLeft ArrowRight Home"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || drag.current) return;
          const element = event.currentTarget;
          element.focus({ preventScroll: true });
          element.setPointerCapture(event.pointerId);
          element.dataset.dragging = "true";
          drag.current = { pointer: event.pointerId, x: event.clientX, width: element.getBoundingClientRect().width };
          scene.beginTurn();
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || event.pointerId !== active.pointer) return;
          scene.turnBy((event.clientX - active.x) / active.width * Math.PI * 2);
          active.x = event.clientX;
        }}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        onBlur={() => endDrag()}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Home") scene.resetTurn();
          else scene.turnBy((event.key === "ArrowLeft" ? -1 : 1) * Math.PI / 12);
        }}>
        <AsciiAnimation scene={scene} label={label} palette={theme} animate={!paused}
          frameRate={GESTURE_FRAME_RATE} fontSize={5.5} className="native-gesture-animation" />
      </div>
      <figcaption>
        <span>{(lesson === "scroll" || lesson === "roles") ? "control hand · action hand" : lesson === 0 ? "both hands" : "action hand"} · drag to turn</span>
        <button type="button" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Play gesture demonstration" : "Pause gesture demonstration"}>{paused ? "play" : "pause"}</button>
      </figcaption>
    </figure>;
});
