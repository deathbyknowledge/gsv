import { useEffect, useState } from "preact/hooks";

const CONSIDER_MS = 1600;
const SETTLE_MS = 900;
/* Matches the dismissal transition in website.css. */
const FADE_MS = 450;

export interface FakePermissionDialogProps {
  /** Runs the sequence once the beat is on screen. */
  active: boolean;
  /** Fired once the refusal has settled, so the beat can show its aftermath. */
  onAnswered?: () => void;
}

/** FakePermissionDialog — a *prop*. It imitates a browser camera/microphone
 *  prompt, waits, then answers "Don't allow" on its own. Nothing here touches
 *  getUserMedia and no permission is ever requested; the refusal is the script.
 *
 *  Deliberately not the design-system Dialog: this is meant to read as the
 *  browser's chrome intruding on the page, so it borrows the shape of a native
 *  permission bubble instead of GSV's own modal vocabulary. */
export function FakePermissionDialog({ active, onAnswered }: FakePermissionDialogProps) {
  const [phase, setPhase] = useState<"hidden" | "asking" | "refusing" | "done" | "gone">(
    "hidden",
  );

  useEffect(() => {
    if (!active || phase !== "hidden") return;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    setPhase("asking");
    timers.push(
      setTimeout(() => {
        if (cancelled) return;
        setPhase("refusing");
        timers.push(
          setTimeout(() => {
            if (cancelled) return;
            setPhase("done");
            onAnswered?.();
            // Leave the layout once the dismissal has played out, so the
            // aftermath line sits where the prompt was rather than below the
            // hole it would otherwise leave behind.
            timers.push(
              setTimeout(() => {
                if (!cancelled) setPhase("gone");
              }, FADE_MS),
            );
          }, SETTLE_MS),
        );
      }, CONSIDER_MS),
    );

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (phase === "hidden" || phase === "gone") return null;

  const refused = phase === "refusing" || phase === "done";

  return (
    <div
      class={`gsv-site-perm${refused ? " is-refused" : ""}${phase === "done" ? " is-done" : ""}`}
      // Not a real dialog: it takes no input and traps no focus. Announcing it
      // as one would promise an interaction that does not exist.
      aria-hidden="true"
    >
      <div class="gsv-site-perm-head">
        <span class="gsv-site-perm-origin gsv-sublabel">gsv.space wants to</span>
      </div>
      <ul class="gsv-site-perm-list">
        <li class="gsv-site-perm-item gsv-prose">
          <span class="gsv-site-perm-dot" aria-hidden="true" />
          Use your camera
        </li>
        <li class="gsv-site-perm-item gsv-prose">
          <span class="gsv-site-perm-dot" aria-hidden="true" />
          Use your microphone
        </li>
      </ul>
      <div class="gsv-site-perm-actions">
        <span class={`gsv-site-perm-btn is-deny${refused ? " is-picked" : ""}`}>
          Don’t allow
        </span>
        <span class="gsv-site-perm-btn is-allow">Allow</span>
      </div>
    </div>
  );
}
