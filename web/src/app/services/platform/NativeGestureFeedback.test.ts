import { describe, expect, it } from "vitest";
import { gestureFeedback } from "./NativeGestureFeedback";
import { practiceCorrection, practiceHold } from "./practiceFeedback";
import { sameNativePresentation } from "./nativePresentation";
import type { NativeSnapshot } from "./PlatformProvider";

const snapshot = (overrides: Partial<NativeSnapshot> = {}): NativeSnapshot => ({
  lease: "view", voice: null, gestures_enabled: true, gesture_status: "ready",
  gesture_context: { mode: "disarmed" }, gesture_progress: null, gesture_action: null, gesture_action_sequence: 0, gesture_needs_reset: false, gesture_reset_after_action: 0,
  gesture_practice: null, scroll_velocity: 0, scroll_sequence: 0, devices: [], devices_loading: false, notice: null, events: [], ...overrides,
});

describe("gesture feedback", () => {
  it("derives practice readiness from the voice state and observes lesson changes", () => {
    const ready = snapshot({ gesture_context: { mode: "practice", lesson_id: 17 } });
    const voice = {
      request_id: 1, segment_id: 0, revision: 0, text: "", phase: "listening",
      progress: null, muted: false, pending: null,
    };
    expect(gestureFeedback(ready).message).toBe("Ready");
    expect(gestureFeedback({ ...ready, voice }).message).toBe("Listening · fist between commands");
    expect(gestureFeedback({ ...ready, voice: { ...voice, phase: "downloading", progress: 0.42 } }).message)
      .toBe("Downloading voice model · 42%");
    expect(gestureFeedback({ ...ready, voice: { ...voice, phase: "finishing" } }).message).toBe("Pausing…");
    expect(sameNativePresentation(ready, { ...ready, gesture_context: { mode: "practice", lesson_id: 18 } })).toBe(false);
  });

  it("explains a wrong practice count without advertising its ordinary action", () => {
    const rejected = snapshot({
      gesture_needs_reset: true,
      gesture_practice: { lesson_id: 17, expected: "listen", feedback_sequence: 1, feedback: { gesture: "three", reason: "wrong_gesture" } },
    });
    expect(practiceCorrection(rejected, "listen")).toBe("Three fingers detected. Make a fist, then show one finger to listen.");
    expect(practiceCorrection({ ...rejected, gesture_needs_reset: false }, "listen")).toBe("Three fingers detected. Show one finger to listen.");
    expect(practiceCorrection(rejected, "send")).toBeNull();
    expect(practiceCorrection({ ...rejected, gestures_enabled: false }, "listen")).toBeNull();
    expect(practiceHold({ ...rejected, gesture_progress: { candidate: "delete_backward", progress_permille: 800 } }, "listen"))
      .toBe("Three fingers detected · this step: show one finger to listen");
    expect(sameNativePresentation(rejected, { ...rejected, gesture_practice: { ...rejected.gesture_practice!, feedback_sequence: 2 } })).toBe(false);
    expect(sameNativePresentation(rejected, { ...rejected, gesture_practice: { ...rejected.gesture_practice!, feedback: null } })).toBe(false);
  });

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
