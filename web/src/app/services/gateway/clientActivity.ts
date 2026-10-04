import { CLIENT_ACTIVITY_INTERVAL_MS, CLIENT_ACTIVITY_SIGNAL } from "@humansandmachines/gsv/protocol";

/** Event driven: mounting, focusing and socket keepalives never claim a reply destination. */
export function trackClientActivity(
  document: Pick<Document, "hidden" | "hasFocus" | "addEventListener" | "removeEventListener">,
  sendSignal: (signal: string) => void,
): () => void {
  let lastSent = Number.NEGATIVE_INFINITY;
  const active = (event: Event) => {
    if (!event.isTrusted || document.hidden || !document.hasFocus()) return;
    const now = Date.now();
    if (now - lastSent < CLIENT_ACTIVITY_INTERVAL_MS) return;
    sendSignal(CLIENT_ACTIVITY_SIGNAL);
    lastSent = now;
  };
  const events = ["pointerdown", "keydown", "wheel"];
  for (const event of events) document.addEventListener(event, active, { capture: true, passive: true });
  return () => {
    for (const event of events) document.removeEventListener(event, active, { capture: true });
  };
}
