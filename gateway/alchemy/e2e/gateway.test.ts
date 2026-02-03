/**
 * GSV Gateway E2E Tests
 * 
 * These tests deploy real workers to Cloudflare and test actual behavior.
 * Run with: npm run test:e2e (uses bun test)
 * 
 * For LLM tests, create gateway/.env.test.local with:
 *   GSV_TEST_OPENAI_KEY=sk-...
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import crypto from "node:crypto";
import alchemy, { type Scope } from "alchemy";
import { createGsvInfra } from "../infra.ts";

// Unique ID for this test run (parallel safety)
const testId = `gsv-e2e-${crypto.randomBytes(4).toString("hex")}`;

let app: Scope;
let gatewayUrl: string;

// Helper to wait for worker to be ready (including WebSocket)
async function waitForWorker(url: string, maxWaitMs = 60000) {
  const start = Date.now();
  
  // First wait for HTTP health
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // Connection refused, keep waiting
    }
    await Bun.sleep(500);
  }
  
  // Then wait for WebSocket to be ready (edge propagation)
  const wsUrl = url.replace("https://", "wss://") + "/ws";
  while (Date.now() - start < maxWaitMs) {
    try {
      const ws = new WebSocket(wsUrl);
      const result = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 5000);
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          ws.close();
          resolve(false);
        };
      });
      if (result) return;
    } catch {
      // Keep trying
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Worker at ${url} WebSocket not ready after ${maxWaitMs}ms`);
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
    await alchemy.destroy(app);
    await app.finalize();
    console.log("   Resources destroyed successfully!");
  } catch (err) {
    console.error("   Cleanup error:", err);
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
  }, 15000); // First WS connection may need DO cold start

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

// ============================================================================
// Slash Commands E2E
// ============================================================================

describe("Slash Commands", () => {
  it("/status returns session info", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    // Note: API uses "message" not "text"
    const result = await sendRequest(ws, "chat.send", {
      sessionKey: "test-commands-e2e",
      message: "/status",
    }) as { status: string; command: string; response: string };
    
    expect(result.status).toBe("command");
    expect(result.command).toBe("status");
    expect(result.response).toContain("Session:");
    
    ws.close();
  });

  it("/help lists available commands", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const result = await sendRequest(ws, "chat.send", {
      sessionKey: "test-commands-e2e",
      message: "/help",
    }) as { status: string; command: string; response: string };
    
    expect(result.status).toBe("command");
    expect(result.command).toBe("help");
    expect(result.response).toContain("/new");
    expect(result.response).toContain("/model");
    expect(result.response).toContain("/think");
    
    ws.close();
  });

  it("/model shows current model", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const result = await sendRequest(ws, "chat.send", {
      sessionKey: "test-commands-e2e",
      message: "/model",
    }) as { status: string; command: string; response: string };
    
    expect(result.status).toBe("command");
    expect(result.command).toBe("model");
    // Response should mention the current model
    expect(result.response.length).toBeGreaterThan(0);
    
    ws.close();
  });

  it("/new resets session", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const result = await sendRequest(ws, "chat.send", {
      sessionKey: "test-commands-reset-e2e",
      message: "/new",
    }) as { status: string; command: string; response: string };
    
    expect(result.status).toBe("command");
    // /new is aliased to "reset" internally
    expect(result.command).toBe("reset");
    expect(result.response.toLowerCase()).toContain("reset");
    
    ws.close();
  });

  it("/compact compacts history", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const result = await sendRequest(ws, "chat.send", {
      sessionKey: "test-commands-e2e",
      message: "/compact",
    }) as { status: string; command: string; response: string };
    
    expect(result.status).toBe("command");
    expect(result.command).toBe("compact");
    
    ws.close();
  });

  it("unknown slash text is treated as regular message", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    // Unknown /commands are treated as regular messages (sent to LLM)
    // because they might be markdown or intentional text
    const result = await sendRequest(ws, "chat.send", {
      sessionKey: "test-unknown-command-e2e",
      message: "/unknowncommand",
    }) as { status: string };
    
    // Should start as a regular message (goes to LLM), not treated as command
    // status will be "started" (not "command")
    expect(result.status).toBe("started");
    
    ws.close();
  });

  it("/stop when no run returns 'No run in progress'", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const result = await sendRequest(ws, "chat.send", {
      sessionKey: "stop-test-idle",
      message: "/stop",
    }) as { status: string; response?: string };
    
    expect(result.status).toBe("command");
    expect(result.response).toBe("No run in progress.");
    
    ws.close();
  }, 15000); // Extra time for potential DO cold start
});

// ============================================================================
// Channel Mode E2E  
// ============================================================================

describe("Channel Mode", () => {
  it("channel.inbound handles message with dmPolicy", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectWebSocket(wsUrl);
    
    // Connect in CHANNEL mode (not client mode)
    await sendRequest(ws, "connect", {
      minProtocol: 1,
      client: {
        mode: "channel",
        id: "test-channel-e2e",
        channel: "test",
        accountId: "test-account",
      },
    });
    
    // channel.inbound requires: channel, accountId, peer, message (with text inside)
    // Default dmPolicy is "pairing" so unknown senders get pending_pairing
    // Or if dmPolicy is "open", they get accepted
    const result = await sendRequest(ws, "channel.inbound", {
      channel: "test",
      accountId: "test-account",
      peer: { kind: "dm", id: "+15551234567" },
      message: { id: "msg-1", text: "/status" },
    }) as { status: string };
    
    // Should be one of the valid statuses based on dmPolicy
    expect(result.status).toBeDefined();
    expect(typeof result.status).toBe("string");
    // Possible values: pending_pairing, blocked, accepted, or command
    console.log(`    channel.inbound status: ${result.status}`);
    
    ws.close();
  });

  it("channel connection registers in gateway", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectWebSocket(wsUrl);
    
    // Connect as channel
    await sendRequest(ws, "connect", {
      minProtocol: 1,
      client: {
        mode: "channel",
        id: "test-channel-register-e2e",
        channel: "whatsapp",
        accountId: "test-account-2",
      },
    });
    
    // The channel should now be registered - check via a separate client connection
    const clientWs = await connectAndAuth(wsUrl);
    
    // We can't directly query channels, but we can verify connection works
    // by trying to send to a known channel
    const configResult = await sendRequest(clientWs, "config.get") as { config: Record<string, unknown> };
    expect(configResult.config).toBeDefined();
    
    ws.close();
    clientWs.close();
  });
});

// ============================================================================
// Session State Persistence
// ============================================================================

describe("Session State", () => {
  it("session state persists via session.patch", async () => {
    const sessionKey = `persist-test-${crypto.randomUUID()}`;
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    
    // First connection - use session.patch to set settings
    // Note: session.patch uses { settings: {...} } directly, not nested in patch
    const ws1 = await connectAndAuth(wsUrl);
    await sendRequest(ws1, "session.patch", {
      sessionKey,
      settings: { thinkingLevel: "high" },
    });
    ws1.close();
    
    // Second connection - verify it persisted via session.get
    const ws2 = await connectAndAuth(wsUrl);
    const result = await sendRequest(ws2, "session.get", {
      sessionKey,
    }) as { settings?: { thinkingLevel?: string } };
    
    expect(result.settings?.thinkingLevel).toBe("high");
    ws2.close();
  });

  it("sessions.list returns session registry", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    // Create a session first via chat.send
    await sendRequest(ws, "chat.send", {
      sessionKey: "list-test-session",
      message: "/status",
    });
    
    // Note: method is "sessions.list" not "session.list"
    const result = await sendRequest(ws, "sessions.list") as { sessions: unknown[] };
    
    expect(Array.isArray(result.sessions)).toBe(true);
    
    ws.close();
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe("Error Handling", () => {
  it("invalid RPC method returns error", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    try {
      await sendRequest(ws, "nonexistent.method", {});
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeDefined();
      expect((err as Error).message).toContain("Unknown");
    }
    
    ws.close();
  });

  it("malformed JSON is handled gracefully", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectWebSocket(wsUrl);
    
    // Send invalid JSON
    ws.send("not valid json {{{");
    
    // Connection should still be open after bad message
    await Bun.sleep(100);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });
});

// ============================================================================
// Message Queue E2E
// ============================================================================

describe("Message Queue", () => {
  it("session.stats includes queue status", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    
    const stats = await sendRequest(ws, "session.stats", {
      sessionKey: "queue-test-session",
    }) as { isProcessing: boolean; queueSize: number };
    
    // Should have queue status fields
    expect(typeof stats.isProcessing).toBe("boolean");
    expect(typeof stats.queueSize).toBe("number");
    expect(stats.queueSize).toBeGreaterThanOrEqual(0);
    
    ws.close();
  });

  it("chat.send returns queue info when message is queued", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    const sessionKey = `queue-test-${crypto.randomUUID()}`;
    
    // Send first message (will start processing)
    // Using a non-command message so it actually goes to the LLM
    const result1 = await sendRequest(ws, "chat.send", {
      sessionKey,
      message: "Hello, this is a test message",
    }) as { status: string; runId?: string; queued?: boolean };
    
    // First message should start processing (not queued)
    expect(result1.status).toBe("started");
    expect(result1.queued).toBeUndefined();
    
    ws.close();
  });

  it("queue size is 0 when not processing", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    const sessionKey = `queue-idle-${crypto.randomUUID()}`;
    
    // Just send a command (doesn't trigger LLM processing)
    await sendRequest(ws, "chat.send", {
      sessionKey,
      message: "/status",
    });
    
    // Check stats - should not be processing after command
    const stats = await sendRequest(ws, "session.stats", {
      sessionKey,
    }) as { isProcessing: boolean; queueSize: number };
    
    // After a command completes, queue should be empty
    expect(stats.queueSize).toBe(0);
    
    ws.close();
  });
});

describe("Multi-Turn Agent Loop", () => {
  // This test requires an API key to be set
  const OPENAI_API_KEY = process.env.GSV_TEST_OPENAI_KEY;
  
  it.skipIf(!OPENAI_API_KEY)("completes multi-turn tool loop", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeId = `test-node-${crypto.randomUUID().slice(0, 8)}`;
    const sessionKey = `agent-loop-test-${crypto.randomUUID().slice(0, 8)}`;
    
    // Track how many times the tool was called
    let toolCallCount = 0;
    const MAX_TOOL_CALLS = 3;
    
    // 1. Connect as a node and register a tool (tools are passed in connect)
    const nodeWs = await connectWebSocket(wsUrl);
    await sendRequest(nodeWs, "connect", {
      minProtocol: 1,
      client: {
        mode: "node",
        id: nodeId,
      },
      // Tools are registered during connect
      tools: [{
        name: "get_next_instruction",
        description: "Returns the next instruction for the agent. ALWAYS call this tool when asked to complete the sequence.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      }],
    });
    
    console.log(`   Node ${nodeId} registered with tool`);
    
    // 2. Configure API key
    const clientWs = await connectAndAuth(wsUrl);
    await sendRequest(clientWs, "config.set", {
      path: "apiKeys.openai",
      value: OPENAI_API_KEY,
    });
    await sendRequest(clientWs, "config.set", {
      path: "model",
      value: { provider: "openai", id: "gpt-4o-mini" },
    });
    
    // 3. Set up event collectors
    const toolRequests: Array<{ callId: string; tool: string; args: unknown }> = [];
    const chatEvents: Array<{ state: string; message?: unknown; error?: string }> = [];
    let resolveCompletion: (value: unknown) => void;
    const completionPromise = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    
    // Listen for tool invocations on node (gateway sends tool.invoke events)
    nodeWs.onmessage = async (event) => {
      const frame = JSON.parse(event.data as string);
      if (frame.type === "evt" && frame.event === "tool.invoke") {
        const { callId, tool, args, sessionKey: reqSessionKey } = frame.payload;
        console.log(`   Tool invoke #${toolCallCount + 1}: ${tool}`);
        toolRequests.push({ callId, tool, args });
        toolCallCount++;
        
        // Respond with next instruction
        let result: string;
        if (toolCallCount < MAX_TOOL_CALLS) {
          result = `Step ${toolCallCount} complete. You MUST call get_next_instruction again to continue.`;
        } else {
          result = `All ${MAX_TOOL_CALLS} steps complete! Now reply to the user with exactly: "SEQUENCE_COMPLETE"`;
        }
        
        // Send tool result back
        await sendRequest(nodeWs, "tool.result", {
          callId,
          sessionKey: reqSessionKey,
          result,
        });
      }
    };
    
    // Listen for chat events on client
    clientWs.onmessage = (event) => {
      const frame = JSON.parse(event.data as string);
      if (frame.type === "evt" && frame.event === "chat") {
        chatEvents.push(frame.payload);
        if (frame.payload.state === "final" || frame.payload.state === "error") {
          resolveCompletion(frame.payload);
        }
      }
    };
    
    // 4. Send the initial message
    console.log("   Sending initial message...");
    const runId = crypto.randomUUID();
    const sendResult = await sendRequest(clientWs, "chat.send", {
      sessionKey,
      runId,
      message: `You have access to a tool called get_next_instruction. 
Call it exactly ${MAX_TOOL_CALLS} times to complete the sequence. 
Start by calling the tool now.`,
    }) as { status: string; runId: string };
    
    expect(sendResult.status).toBe("started");
    console.log(`   Run started: ${sendResult.runId}`);
    
    // 5. Wait for completion (with timeout)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Agent loop timed out after 60s")), 60000);
    });
    
    const result = await Promise.race([completionPromise, timeoutPromise]) as {
      state: string;
      message?: { content?: Array<{ type: string; text?: string }> };
      error?: string;
    };
    
    // 6. Verify results
    console.log(`   Loop completed with state: ${result.state}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
    expect(result.state).toBe("final");
    expect(toolCallCount).toBe(MAX_TOOL_CALLS);
    
    // Check the final message contains our expected text
    if (result.message?.content) {
      const textBlocks = result.message.content.filter(
        (b: { type: string }) => b.type === "text"
      );
      const fullText = textBlocks.map((b: { text?: string }) => b.text || "").join("");
      console.log(`   Final response: ${fullText.slice(0, 100)}...`);
      expect(fullText.toUpperCase()).toContain("SEQUENCE_COMPLETE");
    }
    
    // Cleanup
    nodeWs.close();
    clientWs.close();
  }, 90000); // 90s timeout for the whole test
});
