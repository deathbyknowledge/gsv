import { describe, expect, it } from "vitest";
import { gestureFeedback } from "./NativeGestureFeedback";
import type { NativeSnapshot } from "./PlatformProvider";

const snapshot = (overrides: Partial<NativeSnapshot> = {}): NativeSnapshot => ({
  lease: "view", voice: null, gestures_enabled: true, gesture_status: "ready",
  gesture_context: { mode: "disarmed" }, gesture_progress: null, gesture_action: null, gesture_action_sequence: 0,
  scroll_velocity: 0, scroll_sequence: 0, devices: [], devices_loading: false, notice: null, events: [], ...overrides,
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

  it("shows ready and temporarily busy states without extra user modes", () => {
    expect(gestureFeedback(snapshot({
      gesture_context: { mode: "standby" },
    })).message).toContain("Ready");
    expect(gestureFeedback(snapshot({
      gesture_context: { mode: "disabled" },
    })).message).toContain("Preparing");
  });
});
