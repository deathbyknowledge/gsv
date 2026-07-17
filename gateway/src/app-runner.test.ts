import { describe, expect, it, vi } from "vitest";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  bodyFromText,
  bodyToText,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";
import {
  AppSocketAdmission,
  AppSocketBodyTransport,
  appRunnerWorkerCodeKey,
  requestAppKernelFrame,
} from "./app-runner";
import {
  MAX_BINARY_FRAME_BYTES,
  MAX_JSON_FRAME_BYTES,
} from "./kernel/websocket-admission";

function baseProps(runtimeAccess?: Parameters<typeof appRunnerWorkerCodeKey>[0]["artifact"]["runtimeAccess"]) {
  return {
    appFrame: { uid: 1000 },
    packageId: "pkg-chat",
    artifact: {
      hash: "sha256:abc123",
      ...(runtimeAccess ? { runtimeAccess } : {}),
    },
  };
}

describe("appRunnerWorkerCodeKey", () => {
  it("changes when package runtime access changes", () => {
    const denied = appRunnerWorkerCodeKey(baseProps({ egress: { mode: "none" } }));
    const allowed = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "allowlist", allow: ["api.example.com"] },
    }));

    expect(allowed).not.toBe(denied);
  });

  it("normalizes runtime access object key order", () => {
    const first = appRunnerWorkerCodeKey(baseProps({
      egress: { mode: "none" },
      daemon: { rpcSchedules: true },
      storage: { sql: true },
    }));
    const second = appRunnerWorkerCodeKey(baseProps({
      storage: { sql: true },
      daemon: { rpcSchedules: true },
      egress: { mode: "none" },
    }));

    expect(second).toBe(first);
  });

  it("fences loaded package workers by runtime epoch", () => {
    const first = appRunnerWorkerCodeKey({ ...baseProps(), runtimeEpoch: 3 });
    const resumed = appRunnerWorkerCodeKey({ ...baseProps(), runtimeEpoch: 4 });

    expect(resumed).not.toBe(first);
  });
});

describe("AppRunner body transport", () => {
  it("receives and sends shared binary body frames", async () => {
    const sent: Array<string | ArrayBuffer> = [];
    const socket = {
      send: (value: string | ArrayBuffer) => sent.push(value),
    } as unknown as WebSocket;
    const transport = new AppSocketBodyTransport();
    const incoming = transport.receive(socket, { streamId: 7, length: 3 });

    expect(transport.handleBinary(
      socket,
      buildBinaryFrame(7, BINARY_FRAME_DATA, new TextEncoder().encode("hey")),
    )).toBe(true);
    expect(transport.handleBinary(socket, buildBinaryFrame(7, BINARY_FRAME_END))).toBe(true);
    expect(await bodyToText(incoming)).toBe("hey");

    await transport.send(socket, {
      type: "res",
      id: "request-1",
      ok: true,
      data: { ok: true },
    }, bodyFromText("ok"));

    expect(JSON.parse(sent[0] as string)).toMatchObject({
      type: "res",
      id: "request-1",
      body: { streamId: 1, length: 2 },
    });
    expect(parseBinaryFrame(sent[1] as ArrayBuffer)?.payload).toEqual(new TextEncoder().encode("ok"));
    expect(parseBinaryFrame(sent[2] as ArrayBuffer)?.flags).toBe(BINARY_FRAME_END);
  });

  it("forwards request bodies and preserves response bodies at the kernel boundary", async () => {
    const appRequest = vi.fn(async (_appFrame: unknown, frame: any) => {
      expect(await bodyToText(frame.body)).toBe("request bytes");
      return {
        type: "res" as const,
        id: frame.id,
        ok: true as const,
        data: { ok: true },
        body: bodyFromText("response bytes"),
      };
    });

    const response = await requestAppKernelFrame(
      { appRequest },
      { uid: 1000 } as any,
      "proc.media.read",
      { key: "media-key" },
      { body: bodyFromText("request bytes") },
    );

    expect(appRequest).toHaveBeenCalledOnce();
    expect(response.data).toEqual({ ok: true });
    expect(response.body && await bodyToText(response.body)).toBe("response bytes");
  });

  it("checks delivery eligibility for response headers and every binary body frame", async () => {
    const sent: Array<string | ArrayBuffer> = [];
    let canSend = true;
    const socket = {
      send: (value: string | ArrayBuffer) => {
        sent.push(value);
        if (typeof value === "string") {
          canSend = false;
        }
      },
    } as unknown as WebSocket;
    const transport = new AppSocketBodyTransport(() => canSend);

    await transport.send(socket, {
      type: "res",
      id: "request-1",
      ok: true,
    }, bodyFromText("must not be delivered after expiry"));

    expect(sent).toHaveLength(1);
    expect(typeof sent[0]).toBe("string");
    await expect(transport.send(socket, {
      type: "res",
      id: "request-2",
      ok: true,
    })).rejects.toThrow("delivery is no longer allowed");
  });
});

describe("AppRunner WebSocket admission", () => {
  const activeLifetime = {
    sessionExpiresAt: 120_000,
    appFrameExpiresAt: 180_000,
  };

  it("rejects expired sessions and app frames on restore, messages, and delivery", () => {
    const sessionExpired = new AppSocketAdmission();
    expect(sessionExpired.open("session-expired", activeLifetime, 120_000))
      .toEqual({ admitted: false, reason: "expired" });

    const appFrameExpired = new AppSocketAdmission();
    expect(appFrameExpired.open("frame-expired", {
      sessionExpiresAt: 180_000,
      appFrameExpiresAt: 120_000,
    }, 120_000)).toEqual({ admitted: false, reason: "expired" });

    const connected = new AppSocketAdmission();
    expect(connected.open("socket", activeLifetime, 1).admitted).toBe(true);
    expect(connected.admit("socket", activeLifetime, "json", 10, 120_000))
      .toEqual({ admitted: false, reason: "expired" });
    expect(connected.canDeliver(activeLifetime, 119_999)).toBe(true);
    expect(connected.canDeliver(activeLifetime, 120_000)).toBe(false);
  });

  it("requires hibernated sockets to be re-admitted after an object restart", () => {
    const beforeRestart = new AppSocketAdmission();
    expect(beforeRestart.open("socket", activeLifetime, 1).admitted).toBe(true);
    expect(beforeRestart.admit("socket", activeLifetime, "json", 10, 1).admitted).toBe(true);

    const afterRestart = new AppSocketAdmission();
    expect(afterRestart.admit("socket", activeLifetime, "json", 10, 1))
      .toEqual({ admitted: false, reason: "connection_limit" });
    expect(afterRestart.open("socket", activeLifetime, 1).admitted).toBe(true);
    expect(afterRestart.admit("socket", activeLifetime, "json", 10, 1).admitted).toBe(true);
  });

  it("bounds restored connections and releases capacity when a socket closes", () => {
    const admission = new AppSocketAdmission();
    for (let index = 0; index < 128; index += 1) {
      expect(admission.open(`socket-${index}`, activeLifetime, 1).admitted).toBe(true);
    }
    expect(admission.open("overflow", activeLifetime, 1))
      .toEqual({ admitted: false, reason: "connection_limit" });

    admission.close("socket-0");
    expect(admission.open("replacement", activeLifetime, 1).admitted).toBe(true);
  });

  it("enforces frame, per-socket, and per-runner abuse limits", () => {
    const oversized = new AppSocketAdmission();
    expect(oversized.open("oversized", activeLifetime, 1).admitted).toBe(true);
    expect(oversized.admit("oversized", activeLifetime, "json", MAX_JSON_FRAME_BYTES + 1, 1))
      .toEqual({ admitted: false, reason: "frame_too_large" });
    expect(oversized.admit("oversized", activeLifetime, "binary", MAX_BINARY_FRAME_BYTES + 1, 1))
      .toEqual({ admitted: false, reason: "frame_too_large" });

    const perSocket = new AppSocketAdmission();
    expect(perSocket.open("socket", activeLifetime, 1).admitted).toBe(true);
    for (let index = 0; index < 600; index += 1) {
      expect(perSocket.admit("socket", activeLifetime, "json", 10, 1).admitted).toBe(true);
    }
    expect(perSocket.admit("socket", activeLifetime, "json", 10, 1))
      .toEqual({ admitted: false, reason: "message_rate" });

    const perRunner = new AppSocketAdmission();
    for (let socketIndex = 0; socketIndex < 6; socketIndex += 1) {
      const connectionId = `runner-socket-${socketIndex}`;
      expect(perRunner.open(connectionId, activeLifetime, 1).admitted).toBe(true);
      for (let messageIndex = 0; messageIndex < 500; messageIndex += 1) {
        expect(perRunner.admit(connectionId, activeLifetime, "json", 10, 1).admitted).toBe(true);
      }
    }
    expect(perRunner.admit("runner-socket-0", activeLifetime, "json", 10, 1))
      .toEqual({ admitted: false, reason: "message_rate" });
  });
});
