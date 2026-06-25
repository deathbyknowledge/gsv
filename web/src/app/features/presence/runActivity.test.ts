import { describe, expect, it, vi } from "vitest";
import { createPresenceRunActivity } from "./runActivity";
import type { PresenceLogStatus, PresenceState } from "./types";

function createHarness() {
  let state: PresenceState = "idle";
  const notes: string[] = [];
  const activities: Array<{ status: PresenceLogStatus; body: string; tone?: string }> = [];
  const logUpdates: Array<{ logId: string | null; status: PresenceLogStatus; text?: string }> = [];
  const speechOutput = {
    finalizeRunSpeech: vi.fn(() => false),
    queueRunSpeechFromAnswer: vi.fn(),
    speakReply: vi.fn(() => Promise.resolve()),
  };
  const activity = createPresenceRunActivity({
    isConnected: () => true,
    getSpeakReplies: () => true,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    setNote: (note) => {
      notes.push(note);
    },
    ambientIdleNote: () => "Mind is listening",
    updatePresenceLog: (logId, status, text) => {
      logUpdates.push({ logId, status, text });
    },
    showPresenceActivity: (status, body, tone) => {
      activities.push({ status, body, tone });
    },
    renderIdlePresenceActivity: vi.fn(),
    speechOutput,
  });

  return {
    activity,
    activities,
    logUpdates,
    notes,
    speechOutput,
    getState: () => state,
  };
}

describe("presence run activity", () => {
  it("tracks a run and reacts to streamed text", () => {
    const harness = createHarness();

    harness.activity.trackRun("run-1", "log-1", "hello", "Working");
    harness.activity.handleSignal("proc.run.stream", {
      runId: "run-1",
      event: { type: "text_delta", delta: "hi there" },
    });

    expect(harness.activity.activeRunCount()).toBe(1);
    expect(harness.logUpdates).toContainEqual({ logId: "log-1", status: "Responding", text: undefined });
    expect(harness.notes.at(-1)).toBe("Mind is responding");
    expect(harness.speechOutput.queueRunSpeechFromAnswer).toHaveBeenCalledTimes(1);
    expect(harness.activities.at(-1)).toMatchObject({ status: "Responding", body: "hi there" });
  });

  it("buffers early run signals until the run is tracked", () => {
    const harness = createHarness();

    harness.activity.handleSignal("proc.run.output", {
      runId: "run-2",
      text: "buffered answer",
    });
    expect(harness.logUpdates).toEqual([]);

    harness.activity.trackRun("run-2", "log-2", "prompt", "Working");

    expect(harness.logUpdates).toContainEqual({ logId: "log-2", status: "Responding", text: undefined });
    expect(harness.activities.at(-1)).toMatchObject({ status: "Responding", body: "buffered answer" });
  });

  it("finishes runs and queues final speech", () => {
    const harness = createHarness();

    try {
      harness.activity.trackRun("run-3", "log-3", "prompt", "Working");
      harness.activity.handleSignal("chat.complete", {
        runId: "run-3",
        text: "final answer",
      });

      expect(harness.activity.activeRunCount()).toBe(0);
      expect(harness.logUpdates).toContainEqual({ logId: "log-3", status: "Done", text: undefined });
      expect(harness.speechOutput.finalizeRunSpeech).toHaveBeenCalledTimes(1);
      expect(harness.speechOutput.speakReply).toHaveBeenCalledWith("final answer", expect.any(Object));
    } finally {
      harness.activity.destroy();
    }
  });
});
