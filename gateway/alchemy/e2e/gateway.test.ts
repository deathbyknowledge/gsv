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
let testChannelUrl: string;
const OPENAI_API_KEY = process.env.GSV_TEST_OPENAI_KEY;

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

// Helper to wait for HTTP health on multiple workers
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
    const originalHandler = ws.onmessage;
    const cleanup = () => {
      clearTimeout(timeout);
      ws.onmessage = originalHandler;
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${method}`));
    }, 30000);

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string);
        if (frame.type === "res" && frame.id === id) {
          cleanup();
          if (frame.ok) {
            resolve(frame.payload);
          } else {
            const rawMessage =
              typeof frame.error?.message === "string"
                ? frame.error.message
                : frame.error?.message !== undefined
                  ? String(frame.error.message)
                  : "Request failed";
            reject(new Error(`[${method}] ${rawMessage}`));
          }
          return;
        }
      } catch {
        // Ignore parse errors
      }

      if (typeof originalHandler === "function") {
        originalHandler.call(ws, event);
      }
    };
    
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

type GatewayEventPayload = {
  event: string;
  payload: unknown;
};

function attachGatewayEventCollector(ws: WebSocket): {
  waitForEvent<T>(
    eventName: string,
    options?: {
      timeoutMs?: number;
      description?: string;
      predicate?: (payload: T) => boolean;
    },
  ): Promise<T>;
} {
  const events: GatewayEventPayload[] = [];
  const previousHandler = ws.onmessage;

  ws.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data as string);
      if (frame.type === "evt" && typeof frame.event === "string") {
        events.push({
          event: frame.event,
          payload: frame.payload,
        });
      }
    } catch {
      // Ignore parse errors
    }

    if (typeof previousHandler === "function") {
      previousHandler.call(ws, event);
    }
  };

  return {
    waitForEvent: async <T>(
      eventName: string,
      options?: {
        timeoutMs?: number;
        description?: string;
        predicate?: (payload: T) => boolean;
      },
    ): Promise<T> => {
      const timeoutMs = options?.timeoutMs ?? 10000;
      const description =
        options?.description ?? `${eventName} gateway event`;
      const predicate = options?.predicate;

      return waitFor(async () => {
        for (let i = 0; i < events.length; i += 1) {
          const candidate = events[i];
          if (candidate.event !== eventName) {
            continue;
          }
          const payload = candidate.payload as T;
          if (predicate && !predicate(payload)) {
            continue;
          }
          events.splice(i, 1);
          return payload;
        }
        return null;
      }, {
        timeout: timeoutMs,
        interval: 100,
        description,
      });
    },
  };
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

const EXECUTION_BASELINE_CAPABILITIES = [
  "filesystem.list",
  "filesystem.read",
  "filesystem.write",
  "shell.exec",
] as const;

function buildExecutionNodeRuntime(toolNames: string[]) {
  return {
    hostRole: "execution",
    hostCapabilities: [...EXECUTION_BASELINE_CAPABILITIES],
    toolCapabilities: Object.fromEntries(
      toolNames.map((toolName) => [toolName, ["filesystem.read"]]),
    ),
  };
}

function waitForToolInvoke(
  ws: WebSocket,
  timeoutMs = 5000,
): Promise<{ callId: string; tool: string; args: unknown } | null> {
  return new Promise((resolve) => {
    const originalHandler = ws.onmessage;
    const timeout = setTimeout(() => {
      ws.onmessage = originalHandler;
      resolve(null);
    }, timeoutMs);

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string);
        if (frame.type === "evt" && frame.event === "tool.invoke") {
          clearTimeout(timeout);
          ws.onmessage = originalHandler;
          resolve(frame.payload);
          return;
        }
      } catch {
        // Ignore parse errors
      }

      if (typeof originalHandler === "function") {
        originalHandler.call(ws, event);
      }
    };
  });
}

function waitForRunTerminalState(
  ws: WebSocket,
  runId: string,
  timeoutMs = 60000,
): Promise<{ state: "final" | "error"; error?: string }> {
  return new Promise((resolve, reject) => {
    const originalHandler = ws.onmessage;
    const timeout = setTimeout(() => {
      ws.onmessage = originalHandler;
      reject(new Error(`Timed out waiting for run ${runId} terminal state`));
    }, timeoutMs);

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string);
        if (
          frame.type === "evt" &&
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          (frame.payload?.state === "final" || frame.payload?.state === "error")
        ) {
          clearTimeout(timeout);
          ws.onmessage = originalHandler;
          resolve({
            state: frame.payload.state,
            error:
              typeof frame.payload.error === "string"
                ? frame.payload.error
                : undefined,
          });
          return;
        }
      } catch {
        // Ignore parse errors
      }

      if (typeof originalHandler === "function") {
        originalHandler.call(ws, event);
      }
    };
  });
}

function extractLatestAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (typeof message !== "object" || message === null) {
      continue;
    }

    const role = (message as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }

    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      continue;
    }

    const text = content
      .filter(
        (block): block is { type: string; text?: string } =>
          typeof block === "object" &&
          block !== null &&
          typeof (block as { type?: unknown }).type === "string",
      )
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

// ============================================================================
// Test Setup/Teardown (single deployment for all tests)
// ============================================================================

beforeAll(async () => {
  console.log(`\n🧪 Setting up e2e tests (${testId})...\n`);
  
  app = await alchemy("gsv-e2e", { phase: "up" });
  
  await app.run(async () => {
    const { gateway, testChannel } = await createGsvInfra({
      name: testId,
      entrypoint: "src/index.ts",
      url: true,
      withSkillTemplates: true,
      withTestChannel: true,
    });
    
    gatewayUrl = gateway.url!;
    testChannelUrl = testChannel!.url!;
    console.log(`   Gateway deployed: ${gatewayUrl}`);
    console.log(`   Test Channel deployed: ${testChannelUrl}`);
  });
  
  await waitForWorkers([gatewayUrl, testChannelUrl]);
  await waitForWorker(gatewayUrl);
  console.log("   Workers ready!\n");
}, 120000);

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
}, 120000);

// ============================================================================
// Gateway HTTP & WebSocket
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

describe("Gateway Config RPC - Issue #13 regression", () => {
  it("config.get path=channels does not throw Proxy serialization error", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    // Set a channels value first so the config has Proxy-wrapped data
    await sendRequest(ws, "config.set", {
      path: "channels.whatsapp.dmPolicy",
      value: "pairing",
    });

    // This was the exact call that failed with:
    // "Proxy could not be serialized because it is not a valid RPC receiver type"
    const result = await sendRequest(ws, "config.get", {
      path: "channels",
    }) as { path: string; value: Record<string, unknown> };

    expect(result.path).toBe("channels");
    expect(result.value).toBeDefined();
    expect(typeof result.value).toBe("object");

    ws.close();
  });

  it("config.get with no path returns full config without Proxy error", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    const result = await sendRequest(ws, "config.get") as {
      config: Record<string, unknown>;
    };

    expect(result.config).toBeDefined();
    expect(result.config.channels).toBeDefined();
    expect(result.config.session).toBeDefined();
    expect(result.config.agents).toBeDefined();

    // Verify we can re-serialize (proves no Proxy wrappers survived)
    const serialized = JSON.stringify(result.config);
    const parsed = JSON.parse(serialized);
    expect(parsed.channels).toBeDefined();

    ws.close();
  });
});

describe("Cron RPC - Issue #12 regression", () => {
  it("cron.status does not throw on empty database", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    // This was failing with:
    // "Expected exactly one result from SQL query, but got no results."
    const result = await sendRequest(ws, "cron.status") as {
      enabled: boolean;
      count: number;
    };

    expect(typeof result.enabled).toBe("boolean");
    expect(typeof result.count).toBe("number");
    expect(result.count).toBeGreaterThanOrEqual(0);

    ws.close();
  });

  it("cron.list works on empty database", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    const result = await sendRequest(ws, "cron.list") as {
      jobs: unknown[];
      count: number;
    };

    expect(Array.isArray(result.jobs)).toBe(true);
    expect(typeof result.count).toBe("number");

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
// Channel Mode E2E (WebSocket-based)
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

  it("auto-resets on idle policy and preserves the triggering message", async () => {
    const sessionKey = `auto-reset-idle-${crypto.randomUUID()}`;
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    // Ensure session exists and capture current sessionId
    const initial = await sendRequest(ws, "session.get", {
      sessionKey,
    }) as { sessionId: string };
    const oldSessionId = initial.sessionId;

    // Configure idle reset with 0 minutes to trigger immediately on next run.
    await sendRequest(ws, "session.patch", {
      sessionKey,
      resetPolicy: { mode: "idle", idleMinutes: 0 },
    });

    // Ensure now > updatedAt by at least a few ms before starting run.
    await Bun.sleep(20);

    const started = await sendRequest(ws, "chat.send", {
      sessionKey,
      message: "trigger idle auto reset",
    }) as { status: string };
    expect(started.status).toBe("started");

    let after: {
      sessionId: string;
      previousSessionIds: string[];
      lastResetAt?: number;
      messageCount: number;
    } | null = null;

    // Poll until reset is observed
    for (let i = 0; i < 30; i++) {
      const current = await sendRequest(ws, "session.get", {
        sessionKey,
      }) as {
        sessionId: string;
        previousSessionIds: string[];
        lastResetAt?: number;
        messageCount: number;
      };

      if (
        current.sessionId !== oldSessionId &&
        current.previousSessionIds.includes(oldSessionId)
      ) {
        after = current;
        break;
      }

      await Bun.sleep(100);
    }

    expect(after).not.toBeNull();
    expect(after!.sessionId).not.toBe(oldSessionId);
    expect(after!.previousSessionIds.includes(oldSessionId)).toBe(true);
    expect(typeof after!.lastResetAt).toBe("number");
    // The inbound message should survive reset and be processed in the new session.
    expect(after!.messageCount).toBeGreaterThanOrEqual(1);

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

// ============================================================================
// Node Runtime Validation & Routing
// ============================================================================

describe("Node Runtime Validation & Routing", () => {
  it("rejects node connect when nodeRuntime is missing", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeWs = await connectWebSocket(wsUrl);

    try {
      await sendRequest(nodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: `missing-runtime-${crypto.randomUUID().slice(0, 8)}`,
        },
        tools: [
          {
            name: "shared_tool",
            description: "Shared test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
      });
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("Invalid nodeRuntime");
    } finally {
      nodeWs.close();
    }
  });

  it("rejects unnamespaced shared tools", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const sharedTool = "shared_route_tool";
    const executionNodeId = `exec-node-${crypto.randomUUID().slice(0, 8)}`;
    const specializedNodeId = `spec-node-${crypto.randomUUID().slice(0, 8)}`;

    const executionNodeWs = await connectWebSocket(wsUrl);
    await sendRequest(executionNodeWs, "connect", {
      minProtocol: 1,
      client: {
        mode: "node",
        id: executionNodeId,
      },
      tools: [
        {
          name: sharedTool,
          description: "Shared tool from execution node",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ],
      nodeRuntime: buildExecutionNodeRuntime([sharedTool]),
    });

    const specializedNodeWs = await connectWebSocket(wsUrl);
    await sendRequest(specializedNodeWs, "connect", {
      minProtocol: 1,
      client: {
        mode: "node",
        id: specializedNodeId,
      },
      tools: [
        {
          name: sharedTool,
          description: "Shared tool from specialized node",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ],
      nodeRuntime: {
        hostRole: "specialized",
        hostCapabilities: ["text.search"],
        toolCapabilities: {
          [sharedTool]: ["text.search"],
        },
      },
    });

    const executionInvokePromise = waitForToolInvoke(executionNodeWs, 8000);
    const specializedInvokePromise = waitForToolInvoke(specializedNodeWs, 2500);

    const clientWs = await connectAndAuth(wsUrl);
    try {
      await sendRequest(clientWs, "tool.invoke", {
        tool: sharedTool,
        args: { source: "e2e" },
      });
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("No node provides tool");
    }

    const executionInvoke = await executionInvokePromise;
    const specializedInvoke = await specializedInvokePromise;

    expect(executionInvoke).toBeNull();
    expect(specializedInvoke).toBeNull();

    executionNodeWs.close();
    specializedNodeWs.close();
    clientWs.close();
  }, 30000);
});

describe("Node Probe Lifecycle", () => {
  it("dispatches node.probe on connect and persists probe results in skills status", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeId = `probe-node-${crypto.randomUUID().slice(0, 8)}`;
    const requiredBin = "gh";
    const toolName = `probe_tool_${crypto.randomUUID().slice(0, 8)}`;
    const controlWs = await connectAndAuth(wsUrl);
    const nodeWs = await connectWebSocket(wsUrl);
    const nodeEvents = attachGatewayEventCollector(nodeWs);

    try {
      await sendRequest(nodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: nodeId,
        },
        tools: [
          {
            name: toolName,
            description: "Probe lifecycle test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
        nodeRuntime: buildExecutionNodeRuntime([toolName]),
      });

      const probe = await nodeEvents.waitForEvent<{
        probeId: string;
        kind: string;
        bins: string[];
      }>("node.probe", {
        timeoutMs: 15000,
        description: "initial node.probe event",
        predicate: (payload) =>
          payload.kind === "bins" &&
          Array.isArray(payload.bins) &&
          payload.bins.includes(requiredBin),
      });

      expect(probe.kind).toBe("bins");
      expect(probe.bins).toContain(requiredBin);

      await sendRequest(nodeWs, "node.probe.result", {
        probeId: probe.probeId,
        ok: true,
        bins: { [requiredBin]: true },
      });

      const status = await waitFor(async () => {
        const result = await sendRequest(controlWs, "skills.status", {
          agentId: "main",
        }) as {
          nodes?: Array<{
            nodeId: string;
            hostBins?: string[];
            hostBinStatusUpdatedAt?: number;
            canProbeBins?: boolean;
          }>;
          skills?: Array<{
            name: string;
            eligible: boolean;
            eligibleHosts?: string[];
          }>;
        };

        const node = result.nodes?.find((entry) => entry.nodeId === nodeId);
        const github = result.skills?.find((entry) => entry.name === "github");
        if (!node || !github) {
          return null;
        }
        if (!Array.isArray(node.hostBins) || !node.hostBins.includes(requiredBin)) {
          return null;
        }
        if (typeof node.hostBinStatusUpdatedAt !== "number") {
          return null;
        }
        if (!github.eligible) {
          return null;
        }
        if (!Array.isArray(github.eligibleHosts) || !github.eligibleHosts.includes(nodeId)) {
          return null;
        }
        return { node, github };
      }, {
        timeout: 15000,
        interval: 200,
        description: "skills.status probe result update",
      });

      expect(status.node.canProbeBins).toBe(true);
      expect(typeof status.node.hostBinStatusUpdatedAt).toBe("number");
      expect(status.github.eligible).toBe(true);
    } finally {
      controlWs.close();
      nodeWs.close();
    }
  }, 60000);

  it("re-queues probe on disconnect and re-dispatches it on reconnect", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeId = `probe-replay-${crypto.randomUUID().slice(0, 8)}`;
    const requiredBin = "gh";
    const toolName = `probe_replay_tool_${crypto.randomUUID().slice(0, 8)}`;
    const controlWs = await connectAndAuth(wsUrl);

    let firstNodeWs: WebSocket | null = null;
    let secondNodeWs: WebSocket | null = null;

    try {
      firstNodeWs = await connectWebSocket(wsUrl);
      const firstEvents = attachGatewayEventCollector(firstNodeWs);

      await sendRequest(firstNodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: nodeId,
        },
        tools: [
          {
            name: toolName,
            description: "Probe replay lifecycle test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
        nodeRuntime: buildExecutionNodeRuntime([toolName]),
      });

      const firstProbePromise = firstEvents.waitForEvent<{
        probeId: string;
        kind: string;
        bins: string[];
      }>("node.probe", {
        timeoutMs: 15000,
        description: "first node.probe event",
        predicate: (payload) =>
          payload.kind === "bins" &&
          Array.isArray(payload.bins) &&
          payload.bins.includes(requiredBin),
      });

      const firstProbe = await firstProbePromise;

      firstNodeWs.close();
      firstNodeWs = null;
      await Bun.sleep(500);

      secondNodeWs = await connectWebSocket(wsUrl);
      const secondEvents = attachGatewayEventCollector(secondNodeWs);

      await sendRequest(secondNodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: nodeId,
        },
        tools: [
          {
            name: toolName,
            description: "Probe replay lifecycle test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
        nodeRuntime: buildExecutionNodeRuntime([toolName]),
      });

      const replayProbe = await secondEvents.waitForEvent<{
        probeId: string;
        kind: string;
        bins: string[];
      }>("node.probe", {
        timeoutMs: 15000,
        description: "replayed node.probe event",
        predicate: (payload) =>
          payload.kind === "bins" &&
          Array.isArray(payload.bins) &&
          payload.bins.includes(requiredBin),
      });

      expect(replayProbe.probeId).toBe(firstProbe.probeId);

      await sendRequest(secondNodeWs, "node.probe.result", {
        probeId: replayProbe.probeId,
        ok: true,
        bins: { [requiredBin]: true },
      });

      const updatedNode = await waitFor(async () => {
        const result = await sendRequest(controlWs, "skills.status", {
          agentId: "main",
        }) as {
          nodes?: Array<{
            nodeId: string;
            hostBins?: string[];
          }>;
        };
        const node = result.nodes?.find((entry) => entry.nodeId === nodeId);
        if (!node) {
          return null;
        }
        if (!Array.isArray(node.hostBins) || !node.hostBins.includes(requiredBin)) {
          return null;
        }
        return node;
      }, {
        timeout: 15000,
        interval: 200,
        description: "replayed probe result to show in skills.status",
      });

      expect(updatedNode.hostBins).toContain(requiredBin);
    } finally {
      if (firstNodeWs) {
        firstNodeWs.close();
      }
      if (secondNodeWs) {
        secondNodeWs.close();
      }
      controlWs.close();
    }
  }, 70000);

  it("GCs stale queued probes and allows fresh probes to be created", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeId = `probe-gc-${crypto.randomUUID().slice(0, 8)}`;
    const requiredBin = "gh";
    const toolName = `probe_gc_tool_${crypto.randomUUID().slice(0, 8)}`;
    const probeGcMaxAgeMs = 1200;
    const defaultProbeGcMaxAgeMs = 10 * 60_000;
    const controlWs = await connectAndAuth(wsUrl);

    let firstNodeWs: WebSocket | null = null;
    let secondNodeWs: WebSocket | null = null;

    try {
      await sendRequest(controlWs, "config.set", {
        path: "timeouts.skillProbeMaxAgeMs",
        value: probeGcMaxAgeMs,
      });

      firstNodeWs = await connectWebSocket(wsUrl);
      const firstEvents = attachGatewayEventCollector(firstNodeWs);

      await sendRequest(firstNodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: nodeId,
        },
        tools: [
          {
            name: toolName,
            description: "Probe GC lifecycle test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
        nodeRuntime: buildExecutionNodeRuntime([toolName]),
      });

      const firstProbePromise = firstEvents.waitForEvent<{
        probeId: string;
        kind: string;
        bins: string[];
      }>("node.probe", {
        timeoutMs: 15000,
        description: "first node.probe event before GC",
        predicate: (payload) =>
          payload.kind === "bins" &&
          Array.isArray(payload.bins) &&
          payload.bins.includes(requiredBin),
      });

      const firstProbe = await firstProbePromise;

      firstNodeWs.close();
      firstNodeWs = null;

      await Bun.sleep(probeGcMaxAgeMs + 2000);

      secondNodeWs = await connectWebSocket(wsUrl);
      const secondEvents = attachGatewayEventCollector(secondNodeWs);

      await sendRequest(secondNodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: nodeId,
        },
        tools: [
          {
            name: toolName,
            description: "Probe GC lifecycle test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
        nodeRuntime: buildExecutionNodeRuntime([toolName]),
      });

      const secondProbe = await secondEvents.waitForEvent<{
        probeId: string;
        kind: string;
        bins: string[];
      }>("node.probe", {
        timeoutMs: 15000,
        description: "node.probe event after stale probe GC",
        predicate: (payload) =>
          payload.kind === "bins" &&
          Array.isArray(payload.bins) &&
          payload.bins.includes(requiredBin),
      });

      // If stale probe wasn't GC'd, reconnect would replay the same probeId.
      expect(secondProbe.probeId).not.toBe(firstProbe.probeId);

      await sendRequest(secondNodeWs, "node.probe.result", {
        probeId: secondProbe.probeId,
        ok: true,
        bins: { [requiredBin]: true },
      });

      const updatedNode = await waitFor(async () => {
        const result = await sendRequest(controlWs, "skills.status", {
          agentId: "main",
        }) as {
          nodes?: Array<{
            nodeId: string;
            hostBins?: string[];
          }>;
        };
        const node = result.nodes?.find((entry) => entry.nodeId === nodeId);
        if (!node) {
          return null;
        }
        if (!Array.isArray(node.hostBins) || !node.hostBins.includes(requiredBin)) {
          return null;
        }
        return node;
      }, {
        timeout: 15000,
        interval: 200,
        description: "post-GC probe result to show in skills.status",
      });

      expect(updatedNode.hostBins).toContain(requiredBin);
    } finally {
      try {
        await sendRequest(controlWs, "config.set", {
          path: "timeouts.skillProbeMaxAgeMs",
          value: defaultProbeGcMaxAgeMs,
        });
      } catch {
        // Best-effort cleanup
      }
      if (firstNodeWs) {
        firstNodeWs.close();
      }
      if (secondNodeWs) {
        secondNodeWs.close();
      }
      controlWs.close();
    }
  }, 80000);
});

describe("Node Exec Event Routing", () => {
  it("rejects node.exec.event from non-node clients", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const clientWs = await connectAndAuth(wsUrl);

    try {
      await sendRequest(clientWs, "node.exec.event", {
        eventId: crypto.randomUUID(),
        sessionId: "bg-123",
        event: "finished",
        exitCode: 0,
      });
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain(
        "Only node clients can submit exec events",
      );
    } finally {
      clientWs.close();
    }
  });

  it("drops node.exec.event when async session mapping is unknown", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeId = `exec-event-node-${crypto.randomUUID().slice(0, 8)}`;
    const toolName = `exec_event_tool_${crypto.randomUUID().slice(0, 8)}`;
    const nodeWs = await connectWebSocket(wsUrl);

    try {
      await sendRequest(nodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: nodeId,
        },
        tools: [
          {
            name: toolName,
            description: "Node exec event routing test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
        nodeRuntime: buildExecutionNodeRuntime([toolName]),
      });

      const result = await sendRequest(nodeWs, "node.exec.event", {
        eventId: crypto.randomUUID(),
        sessionId: "missing-bg-session",
        event: "finished",
        exitCode: 0,
        outputTail: "done",
      }) as { ok: boolean; dropped?: boolean };

      expect(result.ok).toBe(true);
      expect(result.dropped).toBe(true);
    } finally {
      nodeWs.close();
    }
  });

  it("drops node.exec.event when payload is invalid", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeId = `exec-event-invalid-${crypto.randomUUID().slice(0, 8)}`;
    const toolName = `exec_event_invalid_tool_${crypto.randomUUID().slice(0, 8)}`;
    const nodeWs = await connectWebSocket(wsUrl);

    try {
      await sendRequest(nodeWs, "connect", {
        minProtocol: 1,
        client: {
          mode: "node",
          id: nodeId,
        },
        tools: [
          {
            name: toolName,
            description: "Node exec event validation test tool",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ],
        nodeRuntime: buildExecutionNodeRuntime([toolName]),
      });

      const invalidEventResult = await sendRequest(nodeWs, "node.exec.event", {
        eventId: crypto.randomUUID(),
        sessionId: "bg-321",
        event: "bogus",
      }) as { ok: boolean; dropped?: boolean };
      expect(invalidEventResult.ok).toBe(true);
      expect(invalidEventResult.dropped).toBe(true);

      const missingSessionResult = await sendRequest(nodeWs, "node.exec.event", {
        eventId: crypto.randomUUID(),
        sessionId: "   ",
        event: "finished",
      }) as { ok: boolean; dropped?: boolean };
      expect(missingSessionResult.ok).toBe(true);
      expect(missingSessionResult.dropped).toBe(true);
    } finally {
      nodeWs.close();
    }
  });
});

// ============================================================================
// Skills Config Runtime Visibility
// ============================================================================

describe("Skills Config Runtime Visibility", () => {
  it.skipIf(!OPENAI_API_KEY)(
    "applies skills.entries toggles on the next run",
    async () => {
      const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
      const controlWs = await connectAndAuth(wsUrl);
      const monitorWs = await connectAndAuth(wsUrl);

      await sendRequest(controlWs, "config.set", {
        path: "apiKeys.openai",
        value: OPENAI_API_KEY,
      });
      await sendRequest(controlWs, "config.set", {
        path: "model",
        value: { provider: "openai", id: "gpt-4o-mini" },
      });

      const proofToken = "gsv-e2e-proof-token-4219";
      const promptMessage =
        "E2E SKILL PROOF: reply with the proof token only. If a matching skill is available, use it.";

      await sendRequest(controlWs, "config.set", {
        path: "skills.entries.e2e-proof",
        value: { enabled: false },
      });

      const disabledSessionKey = `skill-toggle-disabled-${crypto.randomUUID().slice(0, 8)}`;
      const disabledRunId = crypto.randomUUID();
      const disabledSend = await sendRequest(controlWs, "chat.send", {
        sessionKey: disabledSessionKey,
        runId: disabledRunId,
        message: promptMessage,
      }) as { status: string };
      expect(disabledSend.status).toBe("started");

      const disabledTerminal = await waitForRunTerminalState(
        monitorWs,
        disabledRunId,
        90000,
      );
      expect(disabledTerminal.state).toBe("final");
      if (disabledTerminal.error) {
        console.log(`   Disabled run error: ${disabledTerminal.error}`);
      }

      const disabledPreview = await sendRequest(controlWs, "session.preview", {
        sessionKey: disabledSessionKey,
        limit: 40,
      }) as { messages: unknown[] };
      const disabledText = extractLatestAssistantText(disabledPreview.messages);
      expect(disabledText).not.toContain(proofToken);

      await sendRequest(controlWs, "config.set", {
        path: "skills.entries.e2e-proof",
        value: { enabled: true },
      });

      const enabledSessionKey = `skill-toggle-enabled-${crypto.randomUUID().slice(0, 8)}`;
      const enabledRunId = crypto.randomUUID();
      const enabledSend = await sendRequest(controlWs, "chat.send", {
        sessionKey: enabledSessionKey,
        runId: enabledRunId,
        message: promptMessage,
      }) as { status: string };
      expect(enabledSend.status).toBe("started");

      const enabledTerminal = await waitForRunTerminalState(
        monitorWs,
        enabledRunId,
        90000,
      );
      expect(enabledTerminal.state).toBe("final");
      if (enabledTerminal.error) {
        console.log(`   Enabled run error: ${enabledTerminal.error}`);
      }

      const enabledPreview = await sendRequest(controlWs, "session.preview", {
        sessionKey: enabledSessionKey,
        limit: 40,
      }) as { messages: unknown[] };
      const enabledText = extractLatestAssistantText(enabledPreview.messages);
      expect(enabledText).toContain(proofToken);

      // Restore explicit default for later tests in this process.
      await sendRequest(controlWs, "config.set", {
        path: "skills.entries.e2e-proof",
        value: { enabled: true },
      });

      controlWs.close();
      monitorWs.close();
    },
    180000,
  );
});

// ============================================================================
// Multi-Turn Agent Loop
// ============================================================================

describe("Multi-Turn Agent Loop", () => {
  it.skipIf(!OPENAI_API_KEY)("completes multi-turn tool loop", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const nodeId = `test-node-${crypto.randomUUID().slice(0, 8)}`;
    const sessionKey = `agent-loop-test-${crypto.randomUUID().slice(0, 8)}`;
    
    // Track how many times the tool was called
    let toolCallCount = 0;
    const MAX_TOOL_CALLS = 3;
    const MAX_ALLOWED_TOOL_CALLS = MAX_TOOL_CALLS + 3;
    
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
      nodeRuntime: buildExecutionNodeRuntime(["get_next_instruction"]),
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
        } else if (toolCallCount === MAX_TOOL_CALLS) {
          result = `All ${MAX_TOOL_CALLS} steps complete! Now reply to the user with exactly: "SEQUENCE_COMPLETE". Do not call tools again.`;
        } else {
          result = `Sequence is already complete. Do NOT call get_next_instruction again. Reply to the user with exactly: "SEQUENCE_COMPLETE".`;
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
      message: `You have access to get_next_instruction.
Call it now. Keep following its instructions.
When it says all steps are complete, stop calling tools and reply exactly: "SEQUENCE_COMPLETE".`,
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
    expect(toolCallCount).toBeGreaterThanOrEqual(MAX_TOOL_CALLS);
    expect(toolCallCount).toBeLessThanOrEqual(MAX_ALLOWED_TOOL_CALLS);
    expect(toolRequests.every((req) => req.tool === "get_next_instruction")).toBe(
      true,
    );
    
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

// ============================================================================
// Channel Worker (Queue-based communication)
// ============================================================================

describe("Channel Worker Health", () => {
  it("test channel health check works", async () => {
    const res = await fetch(`${testChannelUrl}/health`);
    expect(res.ok).toBe(true);
    
    const body = await res.json() as { service: string; status: string };
    expect(body.service).toBe("gsv-channel-test");
    expect(body.status).toBe("ok");
  });

  it("gateway health check works (from channel tests)", async () => {
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

// ============================================================================
// Cron Delivery E2E
// ============================================================================

describe("Cron Delivery", () => {
  const accountId = `cron-delivery-${crypto.randomBytes(4).toString("hex")}`;
  const peerId = `+1555${Date.now().toString().slice(-7)}`;

  beforeAll(async () => {
    // Configure test channel with open dmPolicy
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    await sendRequest(ws, "config.set", {
      path: "channels.test",
      value: { dmPolicy: "open", allowFrom: [] },
    });
    ws.close();

    // Start the test channel account
    await fetch(`${testChannelUrl}/test/start?accountId=${accountId}`, { method: "POST" });
    await Bun.sleep(500);
  }, 30000);

  it("cron CRUD works with new spec format", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    // Add a systemEvent cron job
    const addResult = await sendRequest(ws, "cron.add", {
      name: "e2e-system-event-test",
      schedule: { kind: "at", atMs: Date.now() + 86400000 },
      spec: { mode: "systemEvent", text: "hello from cron" },
      enabled: false,
    }) as { ok: boolean; job: { id: string; spec: { mode: string } } };

    expect(addResult.ok).toBe(true);
    expect(addResult.job.spec.mode).toBe("systemEvent");
    const jobId = addResult.job.id;

    // Add a task cron job
    const taskResult = await sendRequest(ws, "cron.add", {
      name: "e2e-task-test",
      schedule: { kind: "at", atMs: Date.now() + 86400000 },
      spec: {
        mode: "task",
        message: "generate a report",
        deliver: true,
      },
      enabled: false,
    }) as { ok: boolean; job: { id: string; spec: { mode: string; deliver: boolean } } };

    expect(taskResult.ok).toBe(true);
    expect(taskResult.job.spec.mode).toBe("task");
    expect(taskResult.job.spec.deliver).toBe(true);

    // List should include both jobs
    const listResult = await sendRequest(ws, "cron.list") as {
      jobs: Array<{ id: string; name: string; spec: { mode: string } }>;
      count: number;
    };

    const ourJobs = listResult.jobs.filter(
      j => j.name === "e2e-system-event-test" || j.name === "e2e-task-test"
    );
    expect(ourJobs.length).toBe(2);

    // Cleanup
    await sendRequest(ws, "cron.remove", { id: jobId });
    await sendRequest(ws, "cron.remove", { id: taskResult.job.id });

    ws.close();
  });

  it.skipIf(!OPENAI_API_KEY)("systemEvent cron job fires on schedule and delivers to channel", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    // Configure LLM for systemEvent (the cron text becomes a user message that needs an LLM response)
    await sendRequest(ws, "config.set", {
      path: "apiKeys.openai",
      value: OPENAI_API_KEY,
    });
    await sendRequest(ws, "config.set", {
      path: "model",
      value: { provider: "openai", id: "gpt-4o-mini" },
    });

    // First, send an inbound message to establish lastActiveContext for the agent.
    // This tells the Gateway "the user was last seen on the test channel at this peer".
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });
    await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: "/status",
      }),
    });

    // Wait for the /status response to confirm the channel pipeline is working
    await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string }> };
        return body.messages.find(m => m.text.includes("Session:"));
      },
      { timeout: 15000, description: "/status response" }
    );

    // Clear outbound messages so we only see the cron response
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });

    // Schedule a one-shot cron job 1 second in the future.
    // This tests the full DO alarm pipeline: addCronJob → scheduleGatewayAlarm
    // → DO alarm fires at the scheduled time → runCronJobs("due") → delivery.
    const fireAtMs = Date.now() + 1000;
    const addResult = await sendRequest(ws, "cron.add", {
      name: "e2e-scheduled-delivery",
      schedule: { kind: "at", atMs: fireAtMs },
      spec: { mode: "systemEvent", text: "E2E CRON DELIVERY TEST: reply with exactly CRON_DELIVERED" },
      deleteAfterRun: true,
    }) as { ok: boolean; job: { id: string } };

    expect(addResult.ok).toBe(true);
    console.log(`   Cron job scheduled for ${new Date(fireAtMs).toISOString()}, waiting for alarm to fire...`);

    // Do NOT force-run. Wait for the DO alarm to fire on schedule and deliver.
    const outbound = await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string; peer: { id: string } }> };
        return body.messages.find(m => m.peer?.id === peerId);
      },
      { timeout: 30000, interval: 500, description: "scheduled cron response delivery to channel" }
    );

    expect(outbound).toBeDefined();
    console.log(`   Cron response delivered via alarm: ${outbound.text.slice(0, 80)}...`);

    ws.close();
  }, 60000);

  it.skipIf(!OPENAI_API_KEY)("task cron job delivers response to channel via isolated session", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    // Configure LLM for agent responses
    await sendRequest(ws, "config.set", {
      path: "apiKeys.openai",
      value: OPENAI_API_KEY,
    });
    await sendRequest(ws, "config.set", {
      path: "model",
      value: { provider: "openai", id: "gpt-4o-mini" },
    });

    // Establish lastActiveContext
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });
    await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: "/status",
      }),
    });

    await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string }> };
        return body.messages.find(m => m.text.includes("Session:"));
      },
      { timeout: 15000, description: "/status response for task test" }
    );

    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });

    // Create a task cron job with deliver: true
    const addResult = await sendRequest(ws, "cron.add", {
      name: "e2e-task-delivery",
      schedule: { kind: "at", atMs: Date.now() - 1000 },
      spec: {
        mode: "task",
        message: "Reply with exactly: TASK_CRON_DELIVERED",
        deliver: true,
      },
      deleteAfterRun: true,
    }) as { ok: boolean; job: { id: string } };

    expect(addResult.ok).toBe(true);

    // Force-run it
    const runResult = await sendRequest(ws, "cron.run", {
      id: addResult.job.id,
      mode: "force",
    }) as { ok: boolean; ran: number; results: Array<{ status: string; summary?: string }> };

    expect(runResult.ok).toBe(true);
    expect(runResult.ran).toBe(1);
    expect(runResult.results[0].status).toBe("ok");
    // Task mode uses isolated session key
    expect(runResult.results[0].summary).toContain("agent:main:cron:");

    console.log(`   Task cron job executed, waiting for channel delivery...`);

    const outbound = await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string; peer: { id: string } }> };
        return body.messages.find(m => m.peer?.id === peerId);
      },
      { timeout: 60000, interval: 500, description: "task cron response delivery to channel" }
    );

    expect(outbound).toBeDefined();
    expect(outbound.text.toUpperCase()).toContain("TASK_CRON_DELIVERED");
    console.log(`   Task cron response delivered: ${outbound.text.slice(0, 80)}...`);

    ws.close();
  }, 90000);
});

// ============================================================================
// Message Tool E2E
// ============================================================================

describe("Message Tool", () => {
  const accountId = `msg-tool-${crypto.randomBytes(4).toString("hex")}`;
  const peerId = `+1555${Date.now().toString().slice(-7)}`;

  beforeAll(async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);
    await sendRequest(ws, "config.set", {
      path: "channels.test",
      value: { dmPolicy: "open", allowFrom: [] },
    });
    ws.close();

    await fetch(`${testChannelUrl}/test/start?accountId=${accountId}`, { method: "POST" });
    await Bun.sleep(500);
  }, 30000);

  it.skipIf(!OPENAI_API_KEY)("gsv__Message delivers to channel with implicit context defaulting", async () => {
    const wsUrl = gatewayUrl.replace("https://", "wss://") + "/ws";
    const ws = await connectAndAuth(wsUrl);

    // Configure LLM
    await sendRequest(ws, "config.set", {
      path: "apiKeys.openai",
      value: OPENAI_API_KEY,
    });
    await sendRequest(ws, "config.set", {
      path: "model",
      value: { provider: "openai", id: "gpt-4o-mini" },
    });

    // Establish lastActiveContext via channel inbound (/status is fast, no LLM needed)
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });
    await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: "/status",
      }),
    });

    await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string }> };
        return body.messages.find(m => m.text.includes("Session:"));
      },
      { timeout: 15000, description: "/status response for message tool test" }
    );

    // Clear outbound so we only see the tool-sent message
    await fetch(`${testChannelUrl}/test/clear?accountId=${accountId}`, { method: "POST" });

    // Send a message via channel asking the agent to use gsv__Message.
    // The key: we tell it to only provide `text`, NOT channel or to.
    // The tool should default those from lastActiveContext.
    await fetch(`${testChannelUrl}/test/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        peer: { kind: "dm", id: peerId },
        text: [
          "Call the gsv__Message tool with ONLY the text parameter set to exactly: MSG_TOOL_E2E_PROOF",
          "Do NOT set the channel, to, or any other parameters.",
          "After calling the tool, reply with DONE.",
        ].join("\n"),
      }),
    });

    console.log(`   Waiting for gsv__Message delivery...`);

    // Wait for an outbound message containing the proof token.
    // The tool calls channelBinding.send() directly, so it appears as a separate outbound.
    const outbound = await waitFor(
      async () => {
        const res = await fetch(`${testChannelUrl}/test/outbound?accountId=${accountId}`);
        const body = await res.json() as { messages: Array<{ text: string; peer: { id: string } }> };
        return body.messages.find(m => m.text.includes("MSG_TOOL_E2E_PROOF"));
      },
      { timeout: 60000, interval: 500, description: "gsv__Message delivery to channel" }
    );

    expect(outbound).toBeDefined();
    expect(outbound.peer.id).toBe(peerId);
    console.log(`   gsv__Message delivered: "${outbound.text}" to ${outbound.peer.id}`);

    ws.close();
  }, 90000);
});
