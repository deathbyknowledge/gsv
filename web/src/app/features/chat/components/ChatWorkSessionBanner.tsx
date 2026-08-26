import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";

export type ChatWorkSession = {
  personalName: string | null;
  title: string;
};

type ChatWorkSessionBannerProps = {
  personalName: string | null;
  title: string;
  onBack: () => void;
};

export function workSessionOpenedAnnouncement(session: ChatWorkSession): string {
  const title = session.title.trim() || "Untitled work";
  const personalName = session.personalName?.trim() || "";
  return personalName
    ? `Work session opened: ${title}. ${personalName} remains your personal intelligence in Ship.`
    : `Work session opened: ${title}. This account has no personal intelligence.`;
}

export function workSessionClosedAnnouncement(session: ChatWorkSession): string {
  const personalName = session.personalName?.trim() || "";
  return personalName
    ? "Returned to Ship."
    : "Returned to administration.";
}

export function focusChatSessionTarget(
  container: HTMLElement | null,
  workSessionActive: boolean,
): boolean {
  const target = container?.querySelector<HTMLElement>(
    workSessionActive ? ".gsv-chat-work-session" : ".gsv-chat-agent-main",
  ) ?? null;
  target?.focus();
  return target !== null;
}

export function ChatWorkSessionAnnouncement({
  workSession,
}: {
  workSession: ChatWorkSession | null;
}) {
  const previousSession = useRef<ChatWorkSession | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const active = workSession !== null;
  const personalName = workSession?.personalName ?? null;
  const title = workSession?.title ?? "";

  useEffect(() => {
    const previous = previousSession.current;
    if (workSession) {
      setAnnouncement(workSessionOpenedAnnouncement(workSession));
    } else if (previous) {
      setAnnouncement(workSessionClosedAnnouncement(previous));
    }
    previousSession.current = workSession;
  }, [active, personalName, title]);

  return (
    <div
      class="visually-hidden"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {announcement}
    </div>
  );
}

export function ChatWorkSessionBanner({
  personalName,
  title,
  onBack,
}: ChatWorkSessionBannerProps) {
  const name = personalName?.trim() || "";
  const workTitle = title.trim() || "Untitled work";
  const description = name
    ? `You're inside one piece of Ship's work. ${name} is still your personal intelligence.`
    : "You're inside an internal work process. This account has no personal intelligence.";
  const returnLabel = name ? "SHIP" : "ADMINISTRATION";
  return (
    <section
      class="gsv-chat-work-session"
      aria-label={`Work session: ${workTitle}`}
      tabIndex={-1}
    >
      <div class="gsv-chat-work-session-copy">
        <span class="gsv-label">WORK SESSION</span>
        <strong class="gsv-prose-heading">{workTitle}</strong>
        <p>{description}</p>
      </div>
      <Button label={`BACK TO ${returnLabel}`} onClick={onBack} />
    </section>
  );
}
