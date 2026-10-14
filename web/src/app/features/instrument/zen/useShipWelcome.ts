import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { z } from "zod";
import type { Moment } from "./zenModel";

const FIRST_MESSAGE = "Hi, I’m GSV, your personal assistant! Life is busy, so give me the stuff you'd rather not spend your time on.\n\nI can help with things like reservations, travel, your calendar, research, or things on your computer. Think of anything you would give to a friend with a computer and a free afternoon.";
const SECOND_MESSAGE = "What’s something you’d like off your plate? Something you’ve been putting off, or keep having to deal with. Not sure? Tell me a little about your day and we’ll find a starting point.";

const FIRST_TYPING_MS = 2_500;
const BETWEEN_MESSAGES_MS = 10_000;
const SECOND_TYPING_MS = 1_500;

type Welcome = {
  key: string;
  startedAt: number;
  firstShownAt: number | null;
  secondTypingStartedAt: number | null;
  secondShownAt: number | null;
  stopped: boolean;
};
const storedWelcomeSchema = z.object({
  startedAt: z.number().finite().positive(),
  firstShownAt: z.number().finite().nullable(),
  secondTypingStartedAt: z.number().finite().nullable().optional(),
  secondShownAt: z.number().finite().nullable(),
  stopped: z.boolean(),
});

function welcomeMoment(id: string, text: string, thinking: boolean, timestamp: number): Moment {
  return { id, role: "ship", text, thinking, timestamp, runId: null, streaming: false, activities: [], narration: "" };
}

/** A local presentation for a new Ship conversation; it never writes canonical messages. */
export function useShipWelcome({ active, ready, ship, conversationId, hasHistory,
  firstCommittedHumanMessageAt, hasUncommittedHumanMessage, owner }: {
  active: boolean;
  ready: boolean;
  ship: boolean;
  conversationId: string | null;
  hasHistory: boolean;
  firstCommittedHumanMessageAt: number | null;
  hasUncommittedHumanMessage: boolean;
  owner: string;
}): Moment[] {
  const key = ship && conversationId ? `gsv:ship-welcome:v1:${JSON.stringify([owner, conversationId])}` : null;
  const [welcome, setWelcome] = useState<Welcome | null>(null);
  const [now, setNow] = useState(Date.now);
  const wasUncommitted = useRef(false);
  const recordWelcome = useCallback((next: Welcome) => {
    try { window.localStorage.setItem(next.key, JSON.stringify(next)); } catch { /* Keep the welcome for this mount. */ }
    setWelcome(next);
  }, []);

  useEffect(() => {
    if (!active || !ready || !key || welcome?.key === key) return;
    let stored: Welcome | null = null;
    try {
      const parsed = storedWelcomeSchema.safeParse(JSON.parse(window.localStorage.getItem(key) ?? "null"));
      if (parsed.success && parsed.data.startedAt <= Date.now()) {
        stored = { key, ...parsed.data, secondTypingStartedAt: parsed.data.secondTypingStartedAt ?? null };
      }
    } catch { /* Storage is optional. */ }
    if (!stored && hasHistory) return;
    if (stored && stored.firstShownAt === null) stored = { ...stored, startedAt: Date.now() };
    else if (stored && stored.secondTypingStartedAt !== null && stored.secondShownAt === null) {
      stored = { ...stored, secondTypingStartedAt: Date.now() };
    }
    wasUncommitted.current = false;
    recordWelcome(stored ?? { key, startedAt: Date.now(), firstShownAt: null,
      secondTypingStartedAt: null, secondShownAt: null, stopped: false });
  }, [active, ready, key, hasHistory, recordWelcome, welcome?.key]);

  useEffect(() => {
    if (!welcome || welcome.key !== key || firstCommittedHumanMessageAt === null || welcome.stopped) return;
    recordWelcome({ ...welcome, stopped: true });
  }, [firstCommittedHumanMessageAt, key, recordWelcome, welcome]);

  useEffect(() => {
    if (!active || !welcome || welcome.key !== key || welcome.stopped
      || firstCommittedHumanMessageAt !== null) return;
    if (hasUncommittedHumanMessage) {
      wasUncommitted.current = true;
      return;
    }
    const current = Date.now();
    if (wasUncommitted.current) {
      wasUncommitted.current = false;
      if (welcome.firstShownAt === null) {
        recordWelcome({ ...welcome, startedAt: current });
        return;
      }
      if (welcome.secondTypingStartedAt !== null && welcome.secondShownAt === null) {
        recordWelcome({ ...welcome, secondTypingStartedAt: current });
        return;
      }
    }
    if (welcome.firstShownAt === null && current >= welcome.startedAt + FIRST_TYPING_MS) {
      recordWelcome({ ...welcome, firstShownAt: current });
      return;
    }
    if (welcome.firstShownAt !== null && welcome.secondTypingStartedAt === null && welcome.secondShownAt === null
      && current >= welcome.firstShownAt + BETWEEN_MESSAGES_MS - SECOND_TYPING_MS) {
      recordWelcome({ ...welcome, secondTypingStartedAt: current });
      return;
    }
    if (welcome.secondTypingStartedAt !== null && welcome.secondShownAt === null
      && current >= welcome.secondTypingStartedAt + SECOND_TYPING_MS) {
      recordWelcome({ ...welcome, secondShownAt: current });
      return;
    }
    const next = welcome.firstShownAt === null ? welcome.startedAt + FIRST_TYPING_MS
      : welcome.secondTypingStartedAt === null
        ? welcome.firstShownAt + BETWEEN_MESSAGES_MS - SECOND_TYPING_MS
        : welcome.secondShownAt === null ? welcome.secondTypingStartedAt + SECOND_TYPING_MS : undefined;
    if (next === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), next - current);
    return () => window.clearTimeout(timer);
  }, [active, firstCommittedHumanMessageAt, hasUncommittedHumanMessage, key, now, recordWelcome, welcome]);

  return useMemo(() => {
    if (!ready || !key || welcome?.key !== key) return [];
    const stopped = welcome.stopped || firstCommittedHumanMessageAt !== null || hasUncommittedHumanMessage;
    if (welcome.firstShownAt === null) return stopped ? []
      : [welcomeMoment("welcome:first", "", true, welcome.startedAt)];
    const first = welcomeMoment("welcome:first", FIRST_MESSAGE, false, welcome.firstShownAt);
    if (welcome.secondShownAt !== null) return [first,
      welcomeMoment("welcome:second", SECOND_MESSAGE, false, welcome.secondShownAt)];
    if (stopped || welcome.secondTypingStartedAt === null) return [first];
    return [first, welcomeMoment("welcome:second", "", true, welcome.secondTypingStartedAt)];
  }, [ready, firstCommittedHumanMessageAt, hasUncommittedHumanMessage, key, welcome]);
}
