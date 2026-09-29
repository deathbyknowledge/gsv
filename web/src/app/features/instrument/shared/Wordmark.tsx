import { useEffect, useState } from "preact/hooks";

const GLITCH_EVERY_MS = 3200;
const GLITCH_FOR_MS = 90;

/** The wordmark in phosphor, with the auth galaxy's glitch burst every few seconds. */
export function Wordmark() {
  const [glitch, setGlitch] = useState(false);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const every = window.setInterval(() => {
      setGlitch(true);
      window.setTimeout(() => setGlitch(false), GLITCH_FOR_MS);
    }, GLITCH_EVERY_MS);
    return () => window.clearInterval(every);
  }, []);
  return <span class={`wordmark${glitch ? " is-glitch" : ""}`}>GSV</span>;
}
