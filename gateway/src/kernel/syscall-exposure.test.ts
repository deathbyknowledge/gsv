import { describe, expect, it } from "vitest";
import { isInternalOnlySyscall } from "./syscall-exposure";

describe("internal syscall exposure", () => {
  it("marks ai bootstrap syscalls as internal-only", () => {
    expect(isInternalOnlySyscall("ai.config")).toBe(true);
    expect(isInternalOnlySyscall("ai.tools")).toBe(true);
    expect(isInternalOnlySyscall("codemode.exec")).toBe(true);
    expect(isInternalOnlySyscall("proc.ipc.deliver")).toBe(true);
  });

  it("keeps user-facing syscalls public", () => {
    expect(isInternalOnlySyscall("proc.send")).toBe(false);
    expect(isInternalOnlySyscall("ai.transcription.create")).toBe(false);
    expect(isInternalOnlySyscall("ai.speech.create")).toBe(false);
    expect(isInternalOnlySyscall("proc.ipc.send")).toBe(false);
    expect(isInternalOnlySyscall("sys.config.get")).toBe(false);
    expect(isInternalOnlySyscall("proc.ipc.call")).toBe(false);
  });
});
