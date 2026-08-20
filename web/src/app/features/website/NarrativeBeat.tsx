import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { AsciiGalaxyScan } from "../../components/ui/AsciiGalaxyScan";
// The narrative message reuses the chat dock's own message shape, so its base
// rules (.gsv-sm / -body / -text) must be loaded even though SystemMessage
// itself is not rendered — it carries a meta row this page has no use for.
import "../../components/ui/SystemMessage.css";
import type { Beat } from "./beats";
import { ActionSequence } from "./ActionSequence";
import { CapabilityBoxes } from "./CapabilityBoxes";
import { FakePermissionDialog } from "./FakePermissionDialog";
import { MediaWindow } from "./MediaWindow";

const TYPE_MS = 34;
/** Held at a line break, so the second half of a two-line beat lands separately. */
const BREAK_MS = 520;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Splits *emphasised* runs out of a line and wraps them. Applied to whatever
 *  has been revealed so far, so emphasis appears as the words do. */
function withEmphasis(text: string): ComponentChildren[] {
  return text.split(/(\*[^*]*\*?)/g).map((part, i) => {
    if (part.startsWith("*")) {
      return <em key={i}>{part.replace(/\*/g, "")}</em>;
    }
    return part;
  });
}

/** Types `text` out once, the first time `active` goes true, pausing at line
 *  breaks. Returns the text revealed so far plus whether it is still typing —
 *  the caret only shows while typing, so a finished beat carries no cue. */
function useTypewriter(text: string, active: boolean) {
  const reduced = prefersReducedMotion();
  const [shown, setShown] = useState(reduced ? text : "");
  const [typing, setTyping] = useState(false);
  const started = useRef(reduced);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) => new Promise<void>((res) => { timer = setTimeout(res, ms); });

    async function run() {
      setTyping(true);
      for (let i = 1; i <= text.length; i++) {
        if (cancelled) return;
        setShown(text.slice(0, i));
        await wait(text[i - 1] === "\n" ? BREAK_MS : TYPE_MS);
      }
      if (!cancelled) setTyping(false);
    }

    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setTyping(false);
    };
  }, [active, text]);

  return { shown, typing };
}

export interface NarrativeBeatProps {
  beat: Beat;
  /** True once this beat has been reached. */
  active: boolean;
  /** Index, used only for the data attribute the observer reads back. */
  index: number;
}

/** NarrativeBeat — one full-viewport scroll-snap section carrying one moment of
 *  the agent's monologue plus whatever it puts on screen alongside.
 *
 *  The message body clones the shape of a real assistant message in the app
 *  (`.gsv-sm` → `.gsv-sm-body` → `.gsv-sm-text`) minus the meta row, so it is
 *  literally the same construction the chat dock uses — only larger. */
export function NarrativeBeat({ beat, active, index }: NarrativeBeatProps) {
  const { shown, typing } = useTypewriter(beat.text, active);
  const [answered, setAnswered] = useState(false);
  // Tau's photograph is not in the repo yet; until it is, the window says so
  // rather than showing a broken image.
  const [missingPhoto, setMissingPhoto] = useState(false);

  // Whatever the beat puts on screen waits for its line, so the copy reads first.
  const settled = shown.length >= beat.text.length;
  // Media beats run two columns: the agent speaks on the left, the thing it
  // opened sits on the right — the desktop app's arrangement.
  const split = beat.kind === "galaxy" || beat.kind === "photo";

  const message = (
    <div class="gsv-sm gsv-site-msg">
      <div class="gsv-sm-body">
        {/* The typed copy is decorative duplication — the full line is exposed
            once, unanimated, for assistive tech. */}
        <span class="gsv-site-sr">{beat.text.replace(/\*/g, "")}</span>
        <div class="gsv-sm-text gsv-site-msg-text" aria-hidden="true">
          {withEmphasis(shown)}
          {typing ? <span class="gsv-site-caret" /> : null}
        </div>
      </div>
    </div>
  );

  return (
    <section
      class={`gsv-site-beat${split ? " is-split" : ""}`}
      data-beat-index={index}
      data-beat={beat.id}
      aria-label={`Message ${index + 1}`}
    >
      <div class="gsv-site-beat-inner">
        <div class="gsv-site-beat-said">
          {message}

          {beat.kind === "permission" ? (
            <FakePermissionDialog active={active && settled} onAnswered={() => setAnswered(true)} />
          ) : null}
          {beat.kind === "permission" && answered ? (
            <p class="gsv-site-perm-result gsv-sublabel" aria-hidden="true">
              camera denied · microphone denied
            </p>
          ) : null}

          {beat.kind === "boxes" ? <CapabilityBoxes active={active && settled} /> : null}
          {beat.kind === "actions" ? <ActionSequence active={active && settled} /> : null}
        </div>

        {split ? (
          <div class="gsv-site-beat-shown">
            {beat.kind === "galaxy" ? (
              <MediaWindow title={beat.caption}>
                {/* The grid is cut well below the component's defaults so it
                    doesn't compete with the scroll. */}
                <AsciiGalaxyScan
                  showTexture
                  cols={110}
                  rows={40}
                  particleCount={1500}
                  frameRate={24}
                  fontSize={7}
                  label="The GSV mark forming out of a galaxy of particles"
                />
              </MediaWindow>
            ) : null}

            {beat.kind === "photo" ? (
              <MediaWindow title={beat.caption}>
                {missingPhoto ? (
                  <div class="gsv-site-photo-missing">
                    <span class="gsv-sublabel">Photo not found</span>
                    <code>{beat.src}</code>
                  </div>
                ) : (
                  <img
                    class="gsv-site-photo"
                    src={beat.src}
                    alt={beat.alt ?? ""}
                    loading="lazy"
                    decoding="async"
                    onError={() => setMissingPhoto(true)}
                  />
                )}
              </MediaWindow>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
