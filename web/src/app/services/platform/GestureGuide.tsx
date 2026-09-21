import { memo } from "preact/compat";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { AsciiAnimation } from "../../components/ui/AsciiAnimation";
import { useColorTheme } from "../../components/ui/useColorTheme";
import { createGestureScene, GESTURE_FRAME_RATE, type GestureLesson } from "./gestureScene";

const lessons: readonly { id: GestureLesson; key: string; action: string; description: string; image: string }[] = [
  { id: 0, key: "fists", action: "Arm / disarm", description: "Hold both fists for 0.7 s, then open either hand. Arming enables gesture commands; disarming keeps voice listening.", image: "Two hands closing into fists, holding, then opening" },
  { id: 1, key: "1", action: "Start / finish voice", description: "Hold any one finger, including the thumb. Starts voice when idle; finishes dictation when listening.", image: "An action hand showing one finger, then one thumb, returning to a fist between examples" },
  { id: 2, key: "2", action: "Send", description: "Hold any two fingers to send the current dictation and keep listening.", image: "An action hand showing two fingers, alternating index and middle with thumb and index" },
  { id: 3, key: "3", action: "Delete a character", description: "Hold any three fingers to delete one character from unsent dictation. Thumb + index + middle counts as three too.", image: "An action hand showing three fingers, alternating index, middle and ring with thumb, index and middle" },
  { id: 4, key: "4", action: "Clear dictation", description: "Hold any four fingers for 1 s to clear unsent dictation. Typed text and attachments stay.", image: "An action hand showing four fingers, alternating a folded thumb with a folded little finger" },
  { id: 5, key: "5", action: "Pause / resume mic", description: "Hold all five fingers to pause or resume the microphone. Your current dictation stays.", image: "An action hand opening all five fingers, holding, then returning to a fist" },
  { id: "scroll", key: "scroll", action: "Move through messages", description: "Keep the control palm open and the action hand in a fist. Let them settle, then tilt the line between them. Return to neutral to pause; release either hand to stop.", image: "An open control palm on the left and an action fist on the right tilting the line between their palms" },
];

export const GestureGuide = memo(function GestureGuide() {
  const [selected, setSelected] = useState<GestureLesson>(0);
  const [paused, setPaused] = useState(false);
  const { theme } = useColorTheme();
  const scene = useMemo(() => createGestureScene(selected), [selected]);
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
  const lesson = lessons.find((entry) => entry.id === selected)!;
  return <div class="native-gesture-guide">
    <h3>Gesture guide <span>action hand · right by default</span></h3>
    <p>Any combination counts, including the thumb. Hold until the indicator fills; make a fist between commands.</p>
    <div class="native-gesture-lessons" aria-label="Gesture demonstrations">
      {lessons.map((entry) => <button type="button" key={entry.id}
        aria-pressed={selected === entry.id} aria-controls="native-gesture-example"
        onClick={() => setSelected(entry.id)}>
        <b>{entry.key}</b><span>{entry.action}</span>
      </button>)}
    </div>
    <figure id="native-gesture-example" class="native-gesture-example">
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
        <AsciiAnimation scene={scene} label={lesson.image} palette={theme} animate={!paused}
          frameRate={GESTURE_FRAME_RATE} fontSize={5.5} className="native-gesture-animation" />
      </div>
      <figcaption>
        <span>{selected === "scroll" ? "control hand · action hand" : selected === 0 ? "both hands" : "action hand"} · drag to turn</span>
        <button type="button" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Play gesture demonstration" : "Pause gesture demonstration"}>{paused ? "play" : "pause"}</button>
      </figcaption>
    </figure>
    <p class="native-gesture-description">{lesson.description}</p>
  </div>;
});
