import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { GestureIllustration } from "./GestureIllustration";
import type { GestureLesson } from "./gestureScene";

export const gestureLessons: readonly { id: GestureLesson; key: string; action: string; hint: string; image: string }[] = [
  { id: 1, key: "1", action: "Listen / pause", hint: "Any one finger. Pausing keeps your draft.", image: "One finger or thumb extending, then returning to a fist" },
  { id: 2, key: "2", action: "Send", hint: "Sends your draft and keeps listening.", image: "Two fingers extending, then returning to a fist" },
  { id: 3, key: "3", action: "Delete", hint: "Removes the last dictated character.", image: "Three fingers extending, including an example with the thumb" },
  { id: 4, key: "4", action: "Clear", hint: "Hold for one second. Clears dictation; typed text stays.", image: "Four fingers extending and holding, then returning to a fist" },
  { id: "scroll", key: "tilt", action: "Scroll", hint: "Left palm open, right fist. Settle, then tilt; level to stop.", image: "An open left control hand and right action fist tilting together" },
  { id: 0, key: "fists", action: "Hands-free off", hint: "Hold both fists. Camera and mic stop; your draft stays.", image: "Both hands closing into fists and holding" },
];

export const GestureGuide = memo(function GestureGuide() {
  const [selected, setSelected] = useState<GestureLesson>(1);
  const lesson = gestureLessons.find((entry) => entry.id === selected)!;
  return <div class="native-gesture-guide">
    <h3>Quick guide <span>right hand · any finger combination</span></h3>
    <div class="native-gesture-lessons" aria-label="Gesture demonstrations">
      {gestureLessons.map((entry) => <button type="button" key={entry.id}
        aria-pressed={selected === entry.id} aria-controls="native-gesture-example"
        onClick={() => setSelected(entry.id)}>
        <b>{entry.key}</b><span>{entry.action}</span>
      </button>)}
    </div>
    <div id="native-gesture-example"><GestureIllustration lesson={selected} label={lesson.image} /></div>
    <p class="native-gesture-description">{lesson.hint}</p>
    <p class="native-panel-footnote">Hold for the cue. Make a fist between commands.</p>
  </div>;
});
