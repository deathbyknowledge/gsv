import { describe, expect, it, vi } from "vitest";
import { KernelConnection, type KernelConnectionState } from "./connection";
import type { Kernel } from "./do";
import { Transport } from "./transport";

function admission(gate = { allowed: false as const, code: 503 as const, message: "Managed installation is unavailable" }) {
  const managedWorkGate = vi.fn(async (_options?: { fresh?: boolean }) => gate);
  // SAFETY: a refused admission touches only the installation gate before replying.
  const host = {} as Kernel;
  Object.assign(host, { onboarding: { managedWorkGate } });
  const transport = new Transport(host);
  const sendError = vi.spyOn(transport, "sendError").mockImplementation(() => {});
  const connection = new KernelConnection<KernelConnectionState>(new WebSocketPair()[0], "socket", "https://space.example/ws", null);
  return { transport, managedWorkGate, sendError, connection };
}

describe("WebSocket admission", () => {
  it.each(["sys.connect", "sys.pair.redeem", "account.recovery.redeem", "account.recovery.code.start", "account.recovery.code.redeem"])(
    "confirms the installation with Accounts before %s", async (call) => {
      const { transport, managedWorkGate, sendError, connection } = admission();
      await transport.handleReq(connection, { type: "req", id: "request", call, args: {} });
      expect(managedWorkGate).toHaveBeenCalledExactlyOnceWith({ fresh: true });
      expect(sendError).toHaveBeenCalledExactlyOnceWith(connection, "request", 503, "Managed installation is unavailable", undefined);
    },
  );

  it("lets ordinary traffic reuse a recent confirmation", async () => {
    const { transport, managedWorkGate, connection } = admission();
    await transport.handleReq(connection, { type: "req", id: "request", call: "proc.list", args: {} });
    expect(managedWorkGate).toHaveBeenCalledExactlyOnceWith({ fresh: false });
  });
});
