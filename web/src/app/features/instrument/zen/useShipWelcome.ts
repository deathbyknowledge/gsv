import { useEffect, useMemo, useState } from "preact/hooks";
import type { Moment } from "./zenModel";

const FIRST_MESSAGE = "Hi, I’m GSV, your personal assistant! Life is busy, so give me the stuff you'd rather not spend your time on.\n\nI can help with things like reservations, travel, your calendar, research, or things on your computer. Think of anything you would give to a friend with a computer and a free afternoon.";
const SECOND_MESSAGE = "What’s something you’d like off your plate? Something you’ve been putting off, or keep having to deal with. Not sure? Tell me a little about your day and we’ll find a starting point.";

const FIRST_TYPING_MS = 2_500;
const BETWEEN_MESSAGES_MS = 10_000;
const SECOND_TYPING_MS = 1_500;

type Welcome = { key: string; startedAt: number };

function welcomeMoment(id: string, text: string, thinking: boolean, timestamp: number): Moment {
  return { id, role: "ship", text, thinking, timestamp, runId: null, streaming: false, activities: [], narration: "" };
}

/** A local presentation for a new Ship conversation; it never writes canonical messages. */
export function useShipWelcome({ active, ready, ship, conversationId, hasHistory, firstHumanMessageAt, owner }: {
  active: boolean;
  ready: boolean;
  ship: boolean;
  conversationId: string | null;
  hasHistory: boolean;
  firstHumanMessageAt: number | null;
  owner: string;
}): Moment[] {
  const key = ship && conversationId ? `gsv:ship-welcome:v1:${JSON.stringify([owner, conversationId])}` : null;
  const [welcome, setWelcome] = useState<Welcome | null>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active || !ready || !key || welcome?.key === key) return;
    let startedAt = 0;
    try {
      const stored = Number(window.localStorage.getItem(key));
      if (Number.isFinite(stored) && stored > 0 && stored <= Date.now()) startedAt = stored;
    } catch { /* Storage is optional. */ }
    if (!startedAt) {
      if (hasHistory) return;
      startedAt = Date.now();
      try { window.localStorage.setItem(key, String(startedAt)); } catch { /* Keep the welcome for this mount. */ }
    }
    setWelcome({ key, startedAt });
  }, [active, ready, key, hasHistory, welcome?.key]);

  useEffect(() => {
    if (!active || !welcome || welcome.key !== key || firstHumanMessageAt !== null) return;
    let timer: number | undefined;
    const advance = () => {
      const current = Date.now();
      setNow(current);
      const firstAt = welcome.startedAt + FIRST_TYPING_MS;
      const secondAt = firstAt + BETWEEN_MESSAGES_MS;
      const next = [firstAt, secondAt - SECOND_TYPING_MS, secondAt].find((at) => at > current);
      if (next !== undefined) timer = window.setTimeout(advance, next - current);
    };
    advance();
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [active, firstHumanMessageAt, key, welcome]);

  return useMemo(() => {
    if (!ready || !key || welcome?.key !== key) return [];
    const firstAt = welcome.startedAt + FIRST_TYPING_MS;
    const secondAt = firstAt + BETWEEN_MESSAGES_MS;
    if (firstHumanMessageAt !== null && (firstHumanMessageAt < firstAt || now < firstAt)) return [];
    const first = welcomeMoment("welcome:first", now >= firstAt ? FIRST_MESSAGE : "", now < firstAt,
      now >= firstAt ? firstAt : welcome.startedAt);
    if (firstHumanMessageAt !== null && (firstHumanMessageAt < secondAt || now < secondAt)) return [first];
    if (now < secondAt - SECOND_TYPING_MS) return [first];
    return [first, welcomeMoment("welcome:second", now >= secondAt ? SECOND_MESSAGE : "", now < secondAt,
      now >= secondAt ? secondAt : secondAt - SECOND_TYPING_MS)];
  }, [ready, firstHumanMessageAt, key, welcome, now]);
}
