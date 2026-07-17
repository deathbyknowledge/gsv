import { describe, expect, it } from "vitest";
import {
  MAX_BINARY_FRAME_BYTES,
  MAX_JSON_FRAME_BYTES,
  WebSocketAdmission,
  webSocketMessageSize,
} from "./websocket-admission";

describe("Kernel WebSocket admission", () => {
  it("rejects oversized structured and binary frames before parsing", () => {
    const admission = new WebSocketAdmission();
    admission.open("socket", 1);
    expect(admission.admit("socket", "pending", "json", MAX_JSON_FRAME_BYTES + 1, 1))
      .toEqual({ admitted: false, reason: "frame_too_large" });
    expect(admission.admit("socket", "pending", "binary", MAX_BINARY_FRAME_BYTES + 1, 1))
      .toEqual({ admitted: false, reason: "frame_too_large" });
    expect(webSocketMessageSize("é")).toEqual({ kind: "json", bytes: 2 });
  });

  it("uses a strict pre-auth rate and resets only after the window", () => {
    const admission = new WebSocketAdmission();
    admission.open("socket", 1);
    for (let index = 0; index < 30; index += 1) {
      expect(admission.admit("socket", "pending", "json", 10, 1).admitted).toBe(true);
    }
    expect(admission.admit("socket", "pending", "json", 10, 1))
      .toEqual({ admitted: false, reason: "message_rate" });
    expect(admission.admit("socket", "pending", "json", 10, 60_001).admitted).toBe(true);
  });

  it("does not admit messages for sockets that were never opened or were closed", () => {
    const admission = new WebSocketAdmission();
    expect(admission.admit("socket", "connected", "json", 10, 1).admitted).toBe(false);
    admission.open("socket", 1);
    admission.close("socket");
    expect(admission.admit("socket", "connected", "json", 10, 1).admitted).toBe(false);
  });
});
