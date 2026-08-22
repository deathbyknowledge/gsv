import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableChatBranchHandler,
  requestChatBranch,
} from "./ChatDock";

const forkMutate = vi.fn();

beforeEach(() => {
  forkMutate.mockReset();
});

describe("ChatDock Work branching", () => {
  it("exposes no branch affordance or proc.fork call for admin history", () => {
    const handler = vi.fn();

    expect(availableChatBranchHandler({
      canStartNewTask: false,
      forkPending: false,
      hasActiveProcess: true,
    }, handler)).toBeUndefined();
    expect(requestChatBranch({
      canStartNewTask: false,
      branch: { throughMessageId: 7 },
      forkPending: false,
      hasActiveProcess: true,
      mutate: forkMutate,
      processId: "root-work",
    })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(forkMutate).not.toHaveBeenCalled();
  });

  it("branches canonical conversation messages through their process run", () => {
    expect(requestChatBranch({
      canStartNewTask: true,
      branch: { throughRunId: "run:conversation-message" },
      forkPending: false,
      hasActiveProcess: true,
      mutate: forkMutate,
      processId: "proc:personal",
    })).toBe(true);
    expect(forkMutate).toHaveBeenCalledWith({
      pid: "proc:personal",
      throughRunId: "run:conversation-message",
    });
  });
});
