import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ComponentChildren } from "preact";
import "./SwipeRow.css";

/** Whether the transcript renders in the shell's mobile layout. Provided once
 *  by ChatTranscript; row components and SwipeRow read it so the flag doesn't
 *  thread through every intermediate signature. */
export const TranscriptMobileContext = createContext(false);

export const useTranscriptMobile = (): boolean => useContext(TranscriptMobileContext);

/** ActionRail — the stacked icon-action column a mobile message reveals when
 *  swiped left. Buttons inside get 44px touch sizing from SwipeRow.css. */
export function ActionRail({ children }: { children: ComponentChildren }) {
  return <div class="gsv-chat-action-rail">{children}</div>;
}

export interface SwipeRowProps {
  /** The revealed rail (an <ActionRail>). Without it the row never swipes. */
  rail?: ComponentChildren;
  /** Horizontal alignment of the message inside the pane — "end" for
   *  right-aligned user bubbles. */
  align?: "start" | "end";
  children: ComponentChildren;
}

/** SwipeRow — mobile swipe-to-reveal wrapper. Desktop (or without a rail) it
 *  renders its children untouched. On mobile it becomes a horizontal
 *  scroll-snap scroller: the message pane is snap stop one, the action rail
 *  sits past the right edge as snap stop two. Pure CSS scrolling — taps still
 *  click (the UA suppresses click after pan slop), keyboard focus on a rail
 *  button natively scrolls it into view, and virtualization remounts reset the
 *  row to closed (iOS-like). */
export function SwipeRow({ rail, align = "start", children }: SwipeRowProps) {
  const mobile = useTranscriptMobile();
  if (!mobile || !rail) {
    return <>{children}</>;
  }
  return (
    <div class={`gsv-chat-swipe${align === "end" ? " gsv-chat-swipe--end" : ""}`}>
      <div class="gsv-chat-swipe-track">
        <div class="gsv-chat-swipe-pane">{children}</div>
        {rail}
      </div>
    </div>
  );
}
