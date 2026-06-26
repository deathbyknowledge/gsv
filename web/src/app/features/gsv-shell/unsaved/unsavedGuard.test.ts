import { describe, expect, it, vi } from "vitest";
import { isAnyProbeDirty } from "./unsavedGuard";

describe("unsaved guard — isAnyProbeDirty", () => {
  it("is clean when there are no probes", () => {
    expect(isAnyProbeDirty([])).toBe(false);
  });

  it("is clean when every probe reports clean", () => {
    expect(isAnyProbeDirty([() => false, () => false])).toBe(false);
  });

  it("is dirty when any probe reports dirty", () => {
    expect(isAnyProbeDirty([() => false, () => true, () => false])).toBe(true);
  });

  it("short-circuits on the first dirty probe", () => {
    const later = vi.fn(() => false);
    expect(isAnyProbeDirty([() => true, later])).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it("treats a throwing probe as clean rather than trapping the user", () => {
    const throwing = () => {
      throw new Error("probe blew up");
    };
    expect(isAnyProbeDirty([throwing])).toBe(false);
  });

  it("still detects a dirty probe that follows a throwing one", () => {
    const throwing = () => {
      throw new Error("probe blew up");
    };
    expect(isAnyProbeDirty([throwing, () => true])).toBe(true);
  });

  it("reads probes lazily at call time (live dirty state)", () => {
    let dirty = false;
    const probe = () => dirty;
    expect(isAnyProbeDirty([probe])).toBe(false);
    dirty = true;
    expect(isAnyProbeDirty([probe])).toBe(true);
  });
});
