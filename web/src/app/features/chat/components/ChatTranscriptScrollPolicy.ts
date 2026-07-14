const BOTTOM_EPSILON_PX = 1;

export type ChatTranscriptScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

export function chatTranscriptIsAtBottom(metrics: ChatTranscriptScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= BOTTOM_EPSILON_PX;
}

export function nextChatTranscriptBottomFollow(input: {
  atBottom: boolean;
  following: boolean;
  userScrolledUp: boolean;
}): boolean {
  if (input.userScrolledUp) {
    return false;
  }
  if (input.atBottom) {
    return true;
  }
  return input.following;
}

export function chatTranscriptShouldPauseFollowForWheel(input: {
  defaultPrevented: boolean;
  deltaY: number;
  nestedScrollerCanScrollUp: boolean;
  transcript: ChatTranscriptScrollMetrics;
}): boolean {
  return !input.defaultPrevented
    && input.deltaY < 0
    && !input.nestedScrollerCanScrollUp
    && input.transcript.scrollHeight > input.transcript.clientHeight
    && input.transcript.scrollTop > 0;
}
