import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { Moment } from "./zenModel";

const FIRST_MESSAGE = "Hi, I’m GSV, your personal assistant! Life is busy, so give me the stuff you'd rather not spend your time on.\n\nI can help with things like reservations, travel, your calendar, research, or things on your computer. Think of anything you would give to a friend with a computer and a free afternoon.";
const SECOND_MESSAGE = "What’s something you’d like off your plate? Something you’ve been putting off, or keep having to deal with. Not sure? Tell me a little about your day and we’ll find a starting point.";

const FIRST_TYPING_MS = 2_500;
const BETWEEN_MESSAGES_MS = 10_000;
const SECOND_TYPING_MS = 1_500;

type Welcome = { key: string; startedAt: number; firstShownAt: number | null; secondShownAt: number | null; stopped: boolean };

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
  const recordWelcome = useCallback((next: Welcome) => {
    try { window.localStorage.setItem(next.key, JSON.stringify(next)); } catch { /* Keep the welcome for this mount. */ }
    setWelcome(next);
  }, []);

  useEffect(() => {
    if (!active || !ready || !key || welcome?.key === key) return;
    let stored: Welcome | null = null;
    try {
      const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as Welcome | null;
      if (value && Number.isFinite(value.startedAt) && value.startedAt > 0 && value.startedAt <= Date.now()) {
        stored = { key, startedAt: value.startedAt,
          firstShownAt: Number.isFinite(value.firstShownAt) ? value.firstShownAt : null,
          secondShownAt: Number.isFinite(value.secondShownAt) ? value.secondShownAt : null,
          stopped: value.stopped === true };
      }
    } catch { /* Storage is optional. */ }
    if (!stored && hasHistory) return;
    recordWelcome(stored ?? { key, startedAt: Date.now(), firstShownAt: null, secondShownAt: null, stopped: false });
  }, [active, ready, key, hasHistory, recordWelcome, welcome?.key]);

  useEffect(() => {
    if (!welcome || welcome.key !== key || firstHumanMessageAt === null || welcome.stopped) return;
    recordWelcome({ ...welcome, stopped: true });
  }, [firstHumanMessageAt, key, recordWelcome, welcome]);

  useEffect(() => {
    if (!active || !welcome || welcome.key !== key || welcome.stopped || firstHumanMessageAt !== null) return;
    const current = Date.now();
    if (welcome.firstShownAt === null && current >= welcome.startedAt + FIRST_TYPING_MS) {
      recordWelcome({ ...welcome, firstShownAt: current });
      return;
    }
    if (welcome.firstShownAt !== null && welcome.secondShownAt === null
      && current >= welcome.firstShownAt + BETWEEN_MESSAGES_MS) {
      recordWelcome({ ...welcome, secondShownAt: current });
      return;
    }
    const next = welcome.firstShownAt === null ? welcome.startedAt + FIRST_TYPING_MS
      : welcome.secondShownAt === null
        ? [welcome.firstShownAt + BETWEEN_MESSAGES_MS - SECOND_TYPING_MS,
          welcome.firstShownAt + BETWEEN_MESSAGES_MS].find((at) => at > current)
        : undefined;
    if (next === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), next - current);
    return () => window.clearTimeout(timer);
  }, [active, firstHumanMessageAt, key, now, recordWelcome, welcome]);

  return useMemo(() => {
    if (!ready || !key || welcome?.key !== key) return [];
    const stopped = welcome.stopped || firstHumanMessageAt !== null;
    if (welcome.firstShownAt === null) return stopped ? []
      : [welcomeMoment("welcome:first", "", true, welcome.startedAt)];
    const first = welcomeMoment("welcome:first", FIRST_MESSAGE, false, welcome.firstShownAt);
    if (welcome.secondShownAt !== null) return [first,
      welcomeMoment("welcome:second", SECOND_MESSAGE, false, welcome.secondShownAt)];
    const secondAt = welcome.firstShownAt + BETWEEN_MESSAGES_MS;
    if (stopped || now < secondAt - SECOND_TYPING_MS) return [first];
    return [first, welcomeMoment("welcome:second", "", true, secondAt - SECOND_TYPING_MS)];
  }, [ready, firstHumanMessageAt, key, welcome, now]);
}
