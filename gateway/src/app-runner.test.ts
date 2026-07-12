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
  AppSocketBodyTransport,
  appRunnerWorkerCodeKey,
  requestAppKernelFrame,
} from "./app-runner";

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
});
