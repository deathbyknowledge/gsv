import { describe, expect, it } from "vitest";
import {
  clampWindowPositionToWorkspace,
  detectWindowSnapTarget,
  fitWindowSizeToWorkspace,
  minimumWindowSizeForWorkspace,
  normalizeWorkspaceBounds,
  resizeWindowRect,
  snapOverlayRect,
  type DesktopWorkspaceBounds,
} from "./windowGeometry";

const workspace: DesktopWorkspaceBounds = {
  left: 100,
  top: 50,
  width: 1200,
  height: 800,
};

describe("window geometry", () => {
  it("normalizes tiny workspace bounds to the minimum managed area", () => {
    expect(normalizeWorkspaceBounds({
      left: 10,
      top: 20,
      width: 100,
      height: 120,
    })).toEqual({
      left: 10,
      top: 20,
      width: 336,
      height: 256,
    });
  });

  it("fits window sizes between app minimums and workspace maximums", () => {
    expect(fitWindowSizeToWorkspace(
      { minWidth: 360, minHeight: 300 },
      workspace,
      { width: 2000, height: 100 },
    )).toEqual({
      width: 1184,
      height: 300,
    });
  });

  it("caps oversized app minimums to the workspace maximum size", () => {
    expect(minimumWindowSizeForWorkspace(
      { minWidth: 2000, minHeight: 2000 },
      workspace,
    )).toEqual({
      width: 1184,
      height: 784,
    });
  });

  it("clamps normal window positions inside the workspace margin", () => {
    expect(clampWindowPositionToWorkspace(workspace, {
      x: 2000,
      y: -10,
      width: 500,
      height: 300,
    })).toEqual({
      x: 692,
      y: 8,
    });
  });

  it("computes snap overlay rectangles for left right and maximize targets", () => {
    expect(snapOverlayRect(workspace, "left")).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    });
    expect(snapOverlayRect(workspace, "right")).toEqual({
      x: 600,
      y: 0,
      width: 600,
      height: 800,
    });
    expect(snapOverlayRect(workspace, "maximize")).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
  });

  it("detects snap targets near workspace edges", () => {
    expect(detectWindowSnapTarget(workspace, 700, 70)).toBe("maximize");
    expect(detectWindowSnapTarget(workspace, 120, 200)).toBe("left");
    expect(detectWindowSnapTarget(workspace, 1285, 200)).toBe("right");
    expect(detectWindowSnapTarget(workspace, 700, 400)).toBeNull();
  });

  it("resizes east and south edges within workspace limits", () => {
    expect(resizeWindowRect(
      workspace,
      { width: 320, height: 240 },
      {
        direction: "se",
        startClientX: 500,
        startClientY: 400,
        startX: 100,
        startY: 80,
        startWidth: 600,
        startHeight: 400,
      },
      900,
      900,
    )).toEqual({
      x: 100,
      y: 80,
      width: 1000,
      height: 712,
    });
  });

  it("resizes west and north edges without crossing minimum size", () => {
    expect(resizeWindowRect(
      workspace,
      { width: 320, height: 240 },
      {
        direction: "nw",
        startClientX: 500,
        startClientY: 400,
        startX: 100,
        startY: 80,
        startWidth: 600,
        startHeight: 400,
      },
      1000,
      900,
    )).toEqual({
      x: 380,
      y: 240,
      width: 320,
      height: 240,
    });
  });
});
