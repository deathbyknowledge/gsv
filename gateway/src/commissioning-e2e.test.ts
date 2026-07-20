import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type WireResponse = {
  type: "res";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code: number; message: string };
};

async function openGatewaySocket(path: string): Promise<WebSocket> {
  const response = await SELF.fetch(`https://gsv.test${path}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}

function sendRequest(
  socket: WebSocket,
  frame: Record<string, unknown>,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${String(frame.id)}`));
    }, 10_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(String(event.data)) as WireResponse);
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    socket.send(JSON.stringify(frame));
  });
}

describe("clean commissioning flow", () => {
  it("commissions the first human, routes their user Kernel, and logs in", async () => {
    const username = "alice";
    const password = "correct-horse-battery-staple";
    const unprovisioned = await SELF.fetch("https://gsv.test/ws/alice", {
      headers: { Upgrade: "websocket" },
    });
    expect(unprovisioned.status).toBe(404);
    expect(unprovisioned.webSocket).toBeNull();

    const setupSocket = await openGatewaySocket("/ws");

    const setup = await sendRequest(setupSocket, {
      type: "req",
      id: "setup-1",
      call: "sys.setup",
      args: { username, password },
    });
    expect(setup).toMatchObject({
      type: "res",
      id: "setup-1",
      ok: true,
      data: {
        user: { username, uid: 1000 },
      },
    });
    setupSocket.close(1000, "setup complete");

    const legacySocket = await openGatewaySocket("/ws");
    const misplaced = await sendRequest(legacySocket, {
      type: "req",
      id: "misplaced-connect",
      call: "sys.connect",
      args: {
        protocol: 2,
        client: {
          id: "commissioning-e2e",
          version: "1",
          platform: "test",
          role: "user",
        },
        auth: { username, password },
      },
    });
    expect(misplaced).toMatchObject({
      type: "res",
      id: "misplaced-connect",
      ok: false,
      error: {
        code: 409,
        details: { path: `/ws/${username}` },
      },
    });
    legacySocket.close(1000, "scoped route required");

    const userSocket = await openGatewaySocket(`/ws/${username}`);
    const connected = await sendRequest(userSocket, {
      type: "req",
      id: "connect-1",
      call: "sys.connect",
      args: {
        protocol: 2,
        client: {
          id: "commissioning-e2e",
          version: "1",
          platform: "test",
          role: "user",
        },
        auth: { username, password },
      },
    });
    expect(connected).toMatchObject({
      type: "res",
      id: "connect-1",
      ok: true,
      data: {
        identity: {
          role: "user",
          process: { username, uid: 1000 },
        },
      },
    });
    userSocket.close(1000, "test complete");
  }, 30_000);
});
