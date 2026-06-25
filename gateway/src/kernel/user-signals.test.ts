import { describe, expect, it } from "vitest";
import {
  USER_CONNECTION_SIGNALS,
  USER_PROCESS_SIGNALS,
  isUserProcessSignal,
} from "./user-signals";

describe("user-facing signal policy", () => {
  it("routes process lifecycle and run signals to user connections", () => {
    expect(USER_PROCESS_SIGNALS).toContain("proc.changed");
    expect(USER_PROCESS_SIGNALS).toContain("process.exit");
    expect(USER_PROCESS_SIGNALS).toContain("proc.run.stream");
    expect(USER_PROCESS_SIGNALS).toContain("proc.run.hil.requested");

    for (const signal of USER_PROCESS_SIGNALS) {
      expect(isUserProcessSignal(signal)).toBe(true);
    }
  });

  it("keeps process-private signals off ambient user connections", () => {
    expect(isUserProcessSignal("ipc.reply")).toBe(false);
    expect(isUserProcessSignal("ipc.timeout")).toBe(false);
    expect(isUserProcessSignal("schedule.event")).toBe(false);
    expect(isUserProcessSignal("identity.changed")).toBe(false);
    expect(isUserProcessSignal("exec.status")).toBe(false);
  });

  it("advertises all user connection signals", () => {
    expect(USER_CONNECTION_SIGNALS).toEqual(expect.arrayContaining(USER_PROCESS_SIGNALS));
    expect(USER_CONNECTION_SIGNALS).toEqual(expect.arrayContaining([
      "device.status",
      "adapter.status",
      "pkg.changed",
      "notification.created",
      "notification.updated",
      "notification.dismissed",
    ]));
  });
});
