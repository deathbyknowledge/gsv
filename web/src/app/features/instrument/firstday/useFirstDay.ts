import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

type FirstDayView = "setup" | "setup-return" | "conversation";
type Choice = { key: string; view: FirstDayView };

function storedView(key: string | null): FirstDayView | null {
  if (!key) return null;
  try {
    const value = window.localStorage.getItem(key);
    return value === "setup" || value === "setup-return" || value === "conversation" ? value : null;
  } catch {
    return null;
  }
}

function rememberView(key: string, view: FirstDayView): void {
  try {
    window.localStorage.setItem(key, view);
  } catch {
    // A blocked storage policy leaves this view choice in memory for this page.
  }
}

/** Setup belongs to the human; background Process activity cannot finish it. */
export function useFirstDay({ enabled, ready, gateway, conversationId, ownerUid, hasHumanMessages, hasEarlierMessages }: {
  enabled: boolean;
  ready: boolean;
  gateway: string;
  conversationId: string | null;
  ownerUid: number | null;
  hasHumanMessages: boolean;
  hasEarlierMessages: boolean;
}) {
  const key = enabled && conversationId !== null && ownerUid !== null
    ? `gsv.instrument.first-day:${JSON.stringify([gateway, ownerUid, conversationId])}` : null;
  const stored = useMemo(() => storedView(key), [key]);
  const initialView = stored ?? (hasHumanMessages || hasEarlierMessages ? "conversation" : "setup");
  const [choice, setChoice] = useState<Choice | null>(null);
  const selected = choice?.key === key ? choice.view : initialView;
  // Human messages from another client finish initial setup, but not an explicit return to it.
  const view = selected === "setup" && hasHumanMessages ? "conversation" : selected;

  useEffect(() => {
    if (!key || !ready) return;
    setChoice((current) => current?.key === key && current.view === view ? current : { key, view });
    if (storedView(key) !== view) rememberView(key, view);
  }, [key, ready, view]);

  const choose = useCallback((next: FirstDayView) => {
    if (!key) return;
    setChoice({ key, view: next });
    rememberView(key, next);
  }, [key]);
  const showSetup = useCallback(() => choose("setup-return"), [choose]);
  const showConversation = useCallback(() => choose("conversation"), [choose]);
  return { visible: enabled && ready && key !== null && view !== "conversation", showSetup, showConversation };
}
