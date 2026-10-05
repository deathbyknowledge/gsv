import { afterEach, describe, expect, it, vi } from "vitest";
import { trackClientActivity } from "./clientActivity";

describe("client activity", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reports real foreground input at most every 30 seconds, without a heartbeat or focus claim", () => {
    const listeners = new EventTarget();
    const page = {
      hidden: false, hasFocus: () => true,
      addEventListener: listeners.addEventListener.bind(listeners),
      removeEventListener: listeners.removeEventListener.bind(listeners),
    };
    const send = vi.fn();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const stop = trackClientActivity(page, send);
    const input = (type: string, trusted = true) => {
      const event = new Event(type);
      Object.defineProperty(event, "isTrusted", { value: trusted });
      listeners.dispatchEvent(event);
    };
    expect(send).not.toHaveBeenCalled();
    input("focus"); input("visibilitychange"); input("keydown", false);
    expect(send).not.toHaveBeenCalled();
    input("pointerdown"); input("keydown"); input("wheel");
    expect(send).toHaveBeenCalledExactlyOnceWith("client.activity");
    clock.mockReturnValue(40_000);
    page.hidden = true;
    input("keydown");
    expect(send).toHaveBeenCalledTimes(1);
    page.hidden = false;
    input("wheel");
    expect(send).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(1_000_000);
    expect(send).toHaveBeenCalledTimes(2);
    stop(); input("keydown");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
