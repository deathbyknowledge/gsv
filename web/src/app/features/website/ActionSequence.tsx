import { useEffect, useState } from "preact/hooks";
import { ACTION_STEPS } from "./beats";

const STEP_MS = 900;

export interface ActionSequenceProps {
  /** Only run once the beat is on screen. */
  active: boolean;
}

/** ActionSequence — the "…and do anything else." beat. Each row advances from
 *  pending to running to done, one at a time, so the beat demonstrates that the
 *  agent acts rather than just retrieves. Mock motion: nothing is dispatched.
 *
 *  Under reduced motion every row is rendered already-done, which keeps the
 *  meaning (these things get completed) without the theatre. */
export function ActionSequence({ active }: ActionSequenceProps) {
  const reduced =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

  const [done, setDone] = useState(reduced ? ACTION_STEPS.length : 0);

  useEffect(() => {
    if (!active || reduced) return;
    if (done >= ACTION_STEPS.length) return;

    const timer = setTimeout(() => setDone((n) => Math.min(n + 1, ACTION_STEPS.length)), STEP_MS);
    return () => clearTimeout(timer);
  }, [active, done, reduced]);

  return (
    <ul class="gsv-site-actions" aria-hidden="true">
      {ACTION_STEPS.map((step, i) => {
        const complete = i < done;
        const running = i === done && active && !reduced;
        return (
          <li
            class={`gsv-site-action${complete ? " is-done" : ""}${running ? " is-running" : ""}`}
            key={step.label}
          >
            <span class="gsv-site-action-mark" aria-hidden="true" />
            <span class="gsv-site-action-label gsv-sublabel">
              {complete ? step.done : step.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
