import { describe, expect, it } from "vitest";
import { gestureFeedback } from "./NativeGestureFeedback";
import type { NativeSnapshot } from "./PlatformProvider";

const snapshot = (overrides: Partial<NativeSnapshot> = {}): NativeSnapshot => ({
  lease: "view", voice: null, gestures_enabled: true, armed: false, gesture_status: "ready",
  gesture_context: { mode: "disarmed" }, gesture_progress: null, gesture_action: null,
  scroll_velocity: 0, devices: [], notice: null, events: [], ...overrides,
});

describe("gesture feedback", () => {
  it("distinguishes a recognized hold from an accepted send request", () => {
    const holding = gestureFeedback(snapshot({
      gesture_progress: { candidate: "send", progress_permille: 640 },
    }));
    expect(holding.message).toContain("Hold to send");
    expect(holding.progress).toBe(640);
    expect(holding.action).toBeNull();
    const requested = gestureFeedback(snapshot({ gesture_action: "send" }));
    expect(requested.action).toBe("Send requested");
    expect(requested.progress).toBeNull();
  });

  it("prioritizes a camera failure over recognition or action feedback", () => {
    const feedback = gestureFeedback(snapshot({
      gesture_status: "camera_unavailable",
      gesture_progress: { candidate: "arm", progress_permille: 600 },
      gesture_action: "arm",
    }));
    expect(feedback.message).toContain("camera could not open");
    expect(feedback.progress).toBeNull();
    expect(feedback.action).toBeNull();
  });

  it("shows acknowledged mute state and temporary voice unavailability", () => {
    expect(gestureFeedback(snapshot({
      gesture_context: { mode: "active", voice_request_id: 2, muted: true },
    })).message).toContain("Microphone muted");
    expect(gestureFeedback(snapshot({
      gesture_context: { mode: "disabled" },
    })).message).toContain("Voice is busy");
  });
});
