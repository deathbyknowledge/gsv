import { describe, expect, it } from "vitest";
import { normalizeHilRequest } from "./hil";

const BASE_REQUEST = {
  pid: "pid-1",
  requestId: "hil-1",
  runId: "run-1",
  callId: "call-1",
  toolName: "Shell",
  syscall: "shell.exec",
  args: { input: "pwd" },
  createdAt: 1,
};

describe("HIL request normalization", () => {
  it("preserves the authoritative target exactly", () => {
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      target: "  macbook  ",
    })).toMatchObject({
      target: "  macbook  ",
    });
  });

  it("rejects requests without an authoritative target", () => {
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      args: { input: "pwd", target: "gateway" },
    })).toBeNull();
  });

  it("rejects requests without exact decision correlation", () => {
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      requestId: "",
      target: "gsv",
    })).toBeNull();
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      runId: null,
      target: "gsv",
    })).toBeNull();
  });
});
