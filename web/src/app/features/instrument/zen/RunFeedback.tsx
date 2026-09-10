import { useEffect, useState } from "preact/hooks";
import { formatSeconds } from "./zenModel";

export function RunFeedback({ startedAt, model, place, online, awaitingApproval }: {
  startedAt: number | null;
  model: string | null;
  place: string;
  online: boolean;
  awaitingApproval: boolean;
}) {
  const [observedAt] = useState(() => Date.now());
  const [now, setNow] = useState(observedAt);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, []);
  const elapsed = now - Math.min(startedAt ?? observedAt, observedAt);

  return <div class="zen-run-status" role="status" aria-atomic="false">
    <span class={awaitingApproval ? "is-warn" : "is-live"}>{awaitingApproval ? "waiting for your approval" : "thinking"}</span>
    <span role="timer" aria-live="off">{formatSeconds(elapsed)}</span>
    {model && <span>attempting {model}</span>}
    <span>{place} {online ? "ready" : "offline"}</span>
  </div>;
}
