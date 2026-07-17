import { describe, expect, it } from "vitest";
import { FirstBootAdmission } from "./first-boot-admission";

describe("Kernel first-boot admission", () => {
  it("admits only one mutating setup at a time", () => {
    const admission = new FirstBootAdmission();
    const winner = admission.beginSetup();

    expect(winner).not.toBeNull();
    expect(admission.beginSetup()).toBeNull();

    admission.finishSetup(winner!);
    expect(admission.beginSetup()).not.toBeNull();
  });

  it("invalidates older setup-assist work when setup begins", () => {
    const admission = new FirstBootAdmission();
    const assist = admission.beginAssist();
    const setup = admission.beginSetup();

    expect(assist).not.toBeNull();
    expect(setup).not.toBeNull();
    expect(admission.beginAssist()).toBeNull();
    expect(admission.isAssistCurrent(assist!)).toBe(false);

    admission.finishSetup(setup!);
    expect(admission.isAssistCurrent(assist!)).toBe(false);
    expect(admission.isAssistCurrent(admission.beginAssist()!)).toBe(true);
  });
});
