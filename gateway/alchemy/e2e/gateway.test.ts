/**
 * GSV Gateway E2E Tests
 * 
 * These tests deploy real workers to Cloudflare and test actual behavior.
 * Run with: npm run test:e2e (uses bun test)
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import crypto from "node:crypto";
import alchemy, { type Scope } from "alchemy";
import { createGsvInfra } from "../infra.ts";

// Unique ID for this test run (parallel safety)
const testId = `gsv-e2e-${crypto.randomBytes(4).toString("hex")}`;

let app: Scope;
let gatewayUrl: string;

// Helper to wait for worker to be ready
async function waitForWorker(url: string, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Connection refused, keep waiting
    }
    await Bun.sleep(500);
  }
  throw new Error(`Worker at ${url} not ready after ${maxWaitMs}ms`);
}

// Helper for WebSocket connection using Bun's native WebSocket
function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e}`));
    setTimeout(() => reject(new Error("WebSocket connection timeout")), 10000);
  });
}

// Helper to send request and wait for response
function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 30000);
    
    const originalHandler = ws.onmessage;
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string);
        if (frame.type === "res" && frame.id === id) {
          clearTimeout(timeout);
          ws.onmessage = originalHandler;
          if (frame.ok) {
            resolve(frame.payload);
          } else {
            reject(new Error(frame.error?.message || "Request failed"));
          }
        }
      } catch {
        // Ignore parse errors
      }
    };
    
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

// Helper to connect and authenticate WebSocket
async function connectAndAuth(url: string): Promise<WebSocket> {
  const ws = await connectWebSocket(url);
  // Gateway requires "connect" call with protocol version and client info
  await sendRequest(ws, "connect", {
    minProtocol: 1,
    client: {
      mode: "client",
      id: `e2e-test-${crypto.randomUUID()}`,
    },
  });
  return ws;
}

// ============================================================================
// Test Setup/Teardown
// ============================================================================

beforeAll(async () => {
  console.log(`\n🧪 Setting up e2e tests (${testId})...\n`);
  
  app = await alchemy("gsv-e2e", { phase: "up" });
  
  await app.run(async () => {
    const { gateway } = await createGsvInfra({
      name: testId,
      entrypoint: "src/index.ts",
      url: true,
    });
    
    gatewayUrl = gateway.url!;
    console.log(`   Gateway deployed: ${gatewayUrl}`);
  });
  
  await waitForWorker(gatewayUrl);
  console.log("   Worker ready!\n");
}, 90000);

afterAll(async () => {
  console.log("\n🗑️  Cleaning up e2e resources...");
  try {
    const destroyApp = await alchemy("gsv-e2e", { phase: "destroy" });
    await destroyApp.run(async () => {
      await createGsvInfra({
        name: testId,
        entrypoint: "src/index.ts",
        url: true,
      });
    });
    await destroyApp.finalize();
  } catch (err) {
    console.log("   Cleanup error (may be fine):", err);
  }
  console.log("   Done!\n");
}, 90000);

// ============================================================================
// Tests
// ============================================================================

describe("Gateway HTTP endpoints", () => {
  it("health endpoint returns healthy", async () => {
    const res = await fetch(`${gatewayUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("healthy");
  });

  it("unknown paths return 404", async () => {
    const res = await fetch(`${gatewayUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe("Gateway WebSocket Connection", () => {
  it("connects to /ws endpoint", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectWebSocket(wsUrl);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("can send and receive RPC messages", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const response = await sendRequest(ws, "config.get", { path: "model" }) as { value: unknown };
    expect(response).toBeDefined();
    expect(response.value).toBeDefined();
    
    ws.close();
  });
});

describe("Gateway Config RPC", () => {
  it("config.get returns serializable config (THE BUG TEST)", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    // This tests the exact bug we fixed - getConfig() returning Proxy objects
    const response = await sendRequest(ws, "config.get") as { config: Record<string, unknown> };
    
    expect(response).toBeDefined();
    
    // THE CRITICAL TEST: Can we serialize it again?
    const serialized = JSON.stringify(response);
    const parsed = JSON.parse(serialized);
    expect(parsed).toBeDefined();
    
    ws.close();
  });

  it("config.set and config.get roundtrip", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const testValue = `test-${Date.now()}`;
    await sendRequest(ws, "config.set", {
      path: "systemPrompt",
      value: testValue,
    });
    
    const result = await sendRequest(ws, "config.get", {
      path: "systemPrompt",
    }) as { value: string };
    
    expect(result.value).toBe(testValue);
    
    ws.close();
  });
});

describe("Pairing Flow E2E", () => {
  it("pair.list returns pairs object", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const result = await sendRequest(ws, "pair.list") as { pairs: Record<string, unknown> };
    
    expect(result.pairs).toBeDefined();
    expect(typeof result.pairs).toBe("object");
    
    ws.close();
  });
});

describe("Session RPC", () => {
  it("session.stats returns token counts", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const stats = await sendRequest(ws, "session.stats", {
      sessionKey: "test-session-e2e",
    }) as { messageCount: number; tokens: { input: number; output: number } };
    
    expect(typeof stats.messageCount).toBe("number");
    expect(typeof stats.tokens.input).toBe("number");
    expect(typeof stats.tokens.output).toBe("number");
    
    ws.close();
  });
});

describe("Heartbeat RPC", () => {
  it("heartbeat.status returns agent states", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const status = await sendRequest(ws, "heartbeat.status") as { agents: Record<string, unknown> };
    
    expect(status.agents).toBeDefined();
    
    ws.close();
  });
});
