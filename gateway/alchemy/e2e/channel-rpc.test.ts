/**
 * GSV Channel Queue E2E Tests
 * 
 * Tests the queue-based communication flow between Channel workers and Gateway.
 * Channels send inbound messages to a queue, Gateway consumes and processes them.
 * 
 * Architecture:
 *   TestChannel → [gateway-channel-inbound queue] → Gateway (consumer)
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import crypto from "node:crypto";
import alchemy, { type Scope } from "alchemy";
import { createGsvInfra } from "../infra.ts";

const testId = `gsv-channel-queue-${crypto.randomBytes(4).toString("hex")}`;

let app: Scope;
let gatewayUrl: string;
let testChannelUrl: string;

// Helper to wait for workers to be ready
async function waitForWorkers(urls: string[], maxWaitMs = 60000) {
  const start = Date.now();
  
  for (const url of urls) {
    while (Date.now() - start < maxWaitMs) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) break;
      } catch {
        // Keep waiting
      }
      await Bun.sleep(500);
    }
  }
}

// Helper to poll for a condition with timeout
async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  options: { timeout?: number; interval?: number; description?: string } = {}
): Promise<T> {
  const { timeout = 10000, interval = 200, description = "condition" } = options;
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await Bun.sleep(interval);
  }
  
  throw new Error(`Timeout waiting for ${description} after ${timeout}ms`);
}

// ============================================================================
// Test Setup/Teardown
// ============================================================================

beforeAll(async () => {
  console.log(`\n🧪 Setting up Channel Queue tests (${testId})...\n`);
  
  app = await alchemy("gsv-channel-queue", { phase: "up" });
  
  await app.run(async () => {
    const { gateway, testChannel } = await createGsvInfra({
      name: testId,
      entrypoint: "src/index.ts",
      url: true,
      withTestChannel: true,
    });
    
    gatewayUrl = gateway.url!;
    testChannelUrl = testChannel!.url!;
    
    console.log(`   Gateway deployed: ${gatewayUrl}`);
    console.log(`   Test Channel deployed: ${testChannelUrl}`);
  });
  
  await waitForWorkers([gatewayUrl, testChannelUrl]);
  console.log("   Workers ready!\n");
}, 120000);

afterAll(async () => {
  console.log("\n🗑️  Cleaning up Channel Queue resources...");
  try {
    await alchemy.destroy(app);
    await app.finalize();
    console.log("   Resources destroyed successfully!");
  } catch (err) {
    console.error("   Cleanup error:", err);
  }
  console.log("   Done!\n");
}, 120000);

// ============================================================================
// Tests
// ============================================================================

describe("Channel Worker Health", () => {
  it("test channel health check works", async () => {
    const res = await fetch(`${testChannelUrl}/health`);
    expect(res.ok).toBe(true);
    
    const body = await res.json() as { service: string; status: string };
    expect(body.service).toBe("gsv-channel-test");
    expect(body.status).toBe("ok");
  });

  it("gateway health check works", async () => {
    const res = await fetch(`${gatewayUrl}/health`);
    expect(res.ok).toBe(true);
    
    const body = await res.json() as { status: string };
    expect(body.status).toBe("healthy");
  });
});

describe("Queue-based Inbound Messages", () => {
  const accountId = `test-account-${crypto.randomBytes(4).toString("hex")}`;
  
  it("can start test channel account via HTTP", async () => {
    const res = await fetch(`${testChannelUrl}/test/start?accountId=${accountId}`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);
    
    const body = await res.json() as { ok: boolean; accountId: string };
    expect(body.ok).toBe(true);
    expect(body.accountId).toBe(accountId);
  });

  it("sends inbound message via queue to Gateway", async () => {
    // Send an inbound message via the test channel's HTTP endpoint
    const peerId = `+1555${Date.now().toString().slice(-7)}`;
    const messageText = `/status`; // Use a command that returns quickly
    
    const res = await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: messageText,
        sender: { id: peerId, name: "Test User" },
      }),
    });
    
    expect(res.ok).toBe(true);
    const body = await res.json() as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toMatch(/^test-in-/);
    
    console.log(`   Sent inbound message: ${body.messageId}`);
  });

  it("can stop test channel account via HTTP", async () => {
    const res = await fetch(`${testChannelUrl}/test/stop?accountId=${accountId}`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);
  });
});

describe("Channel Message Recording", () => {
  const accountId = `msg-record-${crypto.randomBytes(4).toString("hex")}`;
  
  it("records inbound messages in test channel", async () => {
    // Start account
    await fetch(`${testChannelUrl}/test/start?accountId=${accountId}`, { method: "POST" });
    
    // Send inbound message
    await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: "+15551234567" },
        text: "Hello from test",
      }),
    });
    
    // Check messages were recorded
    const res = await fetch(`${testChannelUrl}/test/messages?accountId=${accountId}`);
    const body = await res.json() as { messages: Array<{ direction: string; message: unknown }> };
    
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages.some(m => m.direction === "in")).toBe(true);
  });

  it("can clear messages for an account", async () => {
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });
    
    const res = await fetch(`${testChannelUrl}/test/messages?accountId=${accountId}`);
    const body = await res.json() as { messages: unknown[] };
    expect(body.messages.length).toBe(0);
  });

  it("can reset all test channel state", async () => {
    // Reset removes messages but requires accountId now (DO-backed)
    await fetch(`${testChannelUrl}/test/reset?accountId=${accountId}`, { method: "POST" });
    
    // Check messages were cleared
    const res = await fetch(`${testChannelUrl}/test/messages?accountId=${accountId}`);
    const body = await res.json() as { messages: unknown[] };
    expect(body.messages.length).toBe(0);
  });
});

describe("Full Channel Flow with Gateway", () => {
  const accountId = `flow-test-${crypto.randomBytes(4).toString("hex")}`;
  const peerId = `+1555${Date.now().toString().slice(-7)}`;
  
  beforeAll(async () => {
    // Wait for Gateway WebSocket to be ready
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    let ws: WebSocket | null = null;
    
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => {
          ws!.onopen = () => resolve();
          ws!.onerror = () => reject(new Error("WS error"));
          setTimeout(() => reject(new Error("WS timeout")), 5000);
        });
        break;
      } catch {
        if (ws) ws.close();
        await Bun.sleep(1000);
      }
    }
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Could not connect to Gateway WebSocket");
    }
    
    // Connect
    const connectId = crypto.randomUUID();
    ws.send(JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: 1,
        client: { mode: "client", id: "e2e-config" },
      },
    }));
    await new Promise<void>(resolve => {
      ws!.onmessage = (e) => {
        const frame = JSON.parse(e.data as string);
        if (frame.type === "res" && frame.id === connectId) resolve();
      };
    });
    
    // Set open dmPolicy for test channel
    const configId = crypto.randomUUID();
    ws.send(JSON.stringify({
      type: "req",
      id: configId,
      method: "config.set",
      params: {
        path: "channels.test",
        value: { dmPolicy: "open", allowFrom: [] },
      },
    }));
    await new Promise<void>(resolve => {
      ws!.onmessage = (e) => {
        const frame = JSON.parse(e.data as string);
        if (frame.type === "res" && frame.id === configId) resolve();
      };
    });
    
    ws.close();
    console.log(`   Configured test channel with open dmPolicy`);
    
    // Start account
    await fetch(`${testChannelUrl}/test/start?accountId=${accountId}`, { method: "POST" });
    // Give queue time to deliver status message
    await Bun.sleep(500);
  }, 60000);

  it("Gateway receives and processes inbound /status command", async () => {
    // Clear any previous messages
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });
    
    // Send /status command through the channel
    const sendRes = await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: "/status",
      }),
    });
    if (!sendRes.ok) {
      const errorText = await sendRes.text();
      console.error(`   /test/inbound failed: ${sendRes.status} - ${errorText}`);
    }
    expect(sendRes.ok).toBe(true);
    
    // Wait for Gateway to process and send response back
    // The Gateway should call TestChannel.send() with the response
    // This tests the full round-trip: Channel → Queue → Gateway → Channel
    console.log(`   Waiting for outbound response to ${peerId}...`);
    const outbound = await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string; peer: { id: string } }> };
        if (body.messages.length > 0) {
          console.log(`   Found ${body.messages.length} outbound messages:`, body.messages.map(m => m.peer?.id || "no-peer"));
        }
        // Look for a response to our peer
        const response = body.messages.find(m => m.peer.id === peerId);
        return response;
      },
      { timeout: 15000, description: "Gateway response to /status" }
    );
    
    expect(outbound).toBeDefined();
    expect(outbound.text).toContain("Session:");
    console.log(`   Received response: ${outbound.text.slice(0, 50)}...`);
  }, 20000);

  it("Gateway processes /help command through queue", async () => {
    // Clear messages
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });
    
    // Send /help command
    await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: "/help",
      }),
    });
    
    // Wait for response
    const outbound = await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string }> };
        return body.messages.find(m => m.text.includes("/new") || m.text.includes("/model"));
      },
      { timeout: 15000, description: "Gateway response to /help" }
    );
    
    expect(outbound).toBeDefined();
    expect(outbound.text).toContain("/new");
    console.log(`   Received /help response`);
  }, 20000);
});

describe("Queue Latency", () => {
  const accountId = `latency-test-${crypto.randomBytes(4).toString("hex")}`;
  const peerId = `+1555${Date.now().toString().slice(-7)}`;
  
  beforeAll(async () => {
    await fetch(`${testChannelUrl}/test/start?accountId=${accountId}`, { method: "POST" });
    await Bun.sleep(500);
  });

  it("processes command within acceptable latency", async () => {
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });
    
    const startTime = Date.now();
    
    // Send a command
    await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: "/model",
      }),
    });
    
    // Wait for response
    await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string }> };
        return body.messages.length > 0 ? body.messages[0] : null;
      },
      { timeout: 10000, description: "Gateway response" }
    );
    
    const latency = Date.now() - startTime;
    console.log(`   Queue round-trip latency: ${latency}ms`);
    
    // Queue latency should be reasonable (under 5 seconds for a command)
    expect(latency).toBeLessThan(5000);
  }, 15000);
});
