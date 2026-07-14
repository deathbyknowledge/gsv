import { describe, expect, it } from "vitest";
import {
  chatTranscriptIsAtBottom,
  chatTranscriptShouldPauseFollowForWheel,
  nextChatTranscriptBottomFollow,
} from "./ChatTranscriptScrollPolicy";

describe("chat transcript bottom follow", () => {
  it("disengages as soon as the user starts scrolling upward from the bottom", () => {
    expect(nextChatTranscriptBottomFollow({
      atBottom: true,
      following: true,
      userScrolledUp: true,
    })).toBe(false);
  });

  it("does not rearm within the old near-bottom threshold", () => {
    expect(nextChatTranscriptBottomFollow({
      atBottom: false,
      following: false,
      userScrolledUp: false,
    })).toBe(false);
    expect(chatTranscriptIsAtBottom({
      clientHeight: 600,
      scrollHeight: 1_000,
      scrollTop: 390,
    })).toBe(false);
  });

  it("rearms when the viewport reaches the actual bottom", () => {
    expect(chatTranscriptIsAtBottom({
      clientHeight: 600,
      scrollHeight: 1_000,
      scrollTop: 400,
    })).toBe(true);
    expect(nextChatTranscriptBottomFollow({
      atBottom: true,
      following: false,
      userScrolledUp: false,
    })).toBe(true);
  });

  it("pauses follow only when an upward wheel can move the transcript", () => {
    const transcript = {
      clientHeight: 600,
      scrollHeight: 1_000,
      scrollTop: 400,
    };

    expect(chatTranscriptShouldPauseFollowForWheel({
      defaultPrevented: false,
      deltaY: -10,
      nestedScrollerCanScrollUp: false,
      transcript,
    })).toBe(true);
    expect(chatTranscriptShouldPauseFollowForWheel({
      defaultPrevented: false,
      deltaY: -10,
      nestedScrollerCanScrollUp: true,
      transcript,
    })).toBe(false);
    expect(chatTranscriptShouldPauseFollowForWheel({
      defaultPrevented: false,
      deltaY: -10,
      nestedScrollerCanScrollUp: false,
      transcript: { clientHeight: 600, scrollHeight: 600, scrollTop: 0 },
    })).toBe(false);
  });
});
