import { useEffect, useRef, useState } from "preact/hooks";
import "./DesktopHint.css";

const TYPE_MS = 40;
const END_HOLD_MS = 1400;

export interface DesktopHintProps {
  /** Lines typed out once on mount (each already includes its `>` prompt). */
  lines: string[];
  /** Compact single-line copy shown after the intro (or once a node is clicked). */
  minimizedText: string;
  /** When true, skip/stop the intro and drop straight to the minimized footer. */
  collapse?: boolean;
  /** Already played this login — render minimized, skip the intro entirely. */
  played?: boolean;
  /** Called once when the intro finishes (or is skipped) so the parent can
   *  remember it for the rest of the login. */
  onPlayed?: () => void;
}

/** DesktopHint — HUD terminal readout below the desktop nodes. The first time
 *  it mounts in a login it types its lines once with a blinking caret, then
 *  minimizes to a small amber footer. Clicking a node (collapse=true) minimizes
 *  it immediately. `played` (driven from the persistent shell) skips the intro
 *  on later mounts, so it only animates once per login. */
export function DesktopHint({ lines, minimizedText, collapse = false, played = false, onPlayed }: DesktopHintProps) {
  const [minimized, setMinimized] = useState(played || collapse);
  const [shown, setShown] = useState<string[]>(() => lines.map(() => ""));
  const [caret, setCaret] = useState(0);

  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;
  const onPlayedRef = useRef(onPlayed);
  onPlayedRef.current = onPlayed;

  // A node click (or any external collapse signal) latches the minimized state.
  useEffect(() => {
    if (collapse) {
      setMinimized(true);
      onPlayedRef.current?.();
    }
  }, [collapse]);

  // Intro typewriter — runs once per login, then minimizes. Skipped entirely if
  // the intro already played (played=true on mount). The parent gives this
  // component a per-login `key`, so a fresh login remounts it (cancelling any
  // in-flight timer via cleanup) and replays the intro from the top.
  useEffect(() => {
    if (played) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) => new Promise<void>((res) => { timer = setTimeout(res, ms); });

    async function run() {
      if (collapseRef.current) {
        setMinimized(true);
        onPlayedRef.current?.();
        return;
      }
      for (let li = 0; li < lines.length; li++) {
        setCaret(li);
        const text = lines[li];
        for (let i = 1; i <= text.length; i++) {
          if (cancelled || collapseRef.current) return;
          setShown((prev) => {
            const next = prev.slice();
            next[li] = text.slice(0, i);
            return next;
          });
          await wait(TYPE_MS);
        }
      }
      if (cancelled) return;
      await wait(END_HOLD_MS);
      if (!cancelled) {
        setMinimized(true);
        onPlayedRef.current?.();
      }
    }

    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class={`gsv-space-hint${minimized ? " is-min" : ""}`}>
      <span class="gsv-space-hint-sr">{minimizedText}</span>
      {minimized ? (
        <div class="gsv-space-hint-min" aria-hidden="true">{minimizedText}</div>
      ) : (
        <div class="gsv-space-hint-screen" aria-hidden="true">
          {lines.map((_, li) => (
            <div class="gsv-space-hint-line" key={li}>
              <span>{shown[li]}</span>
              {li === caret ? <span class="gsv-space-hint-caret" /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
