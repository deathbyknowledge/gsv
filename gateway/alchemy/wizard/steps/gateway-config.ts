/**
 * Gateway Configuration Step
 * 
 * Configures the deployed Gateway with LLM settings via WebSocket.
 */

import type { Prompter } from "../prompter";
import type { WizardState } from "../types";
import pc from "picocolors";

/**
 * WebSocket frame types matching gateway protocol
 */
type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type ResponseFrame = 
  | { type: "res"; id: string; ok: true; payload?: unknown }
  | { type: "res"; id: string; ok: false; error: { code: number; message: string } };

/**
 * Simple WebSocket client for Gateway configuration
 */
class GatewayClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private requestId = 0;

  async connect(url: string, authToken?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          fn();
        }
      };

      const ws = new WebSocket(url);
      
      const timeout = setTimeout(() => {
        ws.close();
        settle(() => reject(new Error("Connection timeout")));
      }, 15000);

      ws.onopen = () => {
        this.ws = ws;
        
        // Set up message handler before sending connect
        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(event.data as string) as ResponseFrame;
            if (frame.type === "res") {
              const pending = this.pendingRequests.get(frame.id);
              if (pending) {
                this.pendingRequests.delete(frame.id);
                if (frame.ok) {
                  pending.resolve(frame.payload);
                } else {
                  pending.reject(new Error(frame.error.message));
                }
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        };
        
        // Send connect frame (auth is optional - may not be configured yet)
        this.sendRequest("connect", {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "wizard",
            version: "0.1.0",
            platform: "bun",
            mode: "client",
          },
          ...(authToken ? { auth: { token: authToken } } : {}),
        })
        .then(() => settle(() => resolve()))
        .catch((err) => settle(() => reject(err)));
      };

      ws.onerror = (event) => {
        // Extract error message if available
        const errMsg = (event as any).message || (event as any).error || "Unknown error";
        settle(() => reject(new Error(`WebSocket error: ${errMsg}`)));
      };

      ws.onclose = (event) => {
        const reason = event.reason || `code=${event.code}`;
        settle(() => reject(new Error(`Connection closed: ${reason}`)));
      };
    });
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = `req-${++this.requestId}`;
    const frame: RequestFrame = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 10000);

      this.ws!.send(JSON.stringify(frame));
      
      // Wrap resolve/reject to clear timeout
      const originalResolve = this.pendingRequests.get(id)!.resolve;
      const originalReject = this.pendingRequests.get(id)!.reject;
      
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          originalResolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          originalReject(error);
        },
      });
    });
  }

  async configSet(path: string, value: unknown): Promise<void> {
    await this.sendRequest("config.set", { path, value });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Attempt to connect with retries
 */
async function connectWithRetry(
  client: GatewayClient,
  wsUrl: string,
  authToken: string | undefined,
  maxAttempts: number,
  delayMs: number,
  onRetry: (attempt: number, maxAttempts: number) => void,
): Promise<void> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.connect(wsUrl, authToken);
      return; // Success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < maxAttempts) {
        onRetry(attempt, maxAttempts);
        await sleep(delayMs);
      }
    }
  }
  
  throw lastError ?? new Error("Connection failed");
}

/**
 * Configure Gateway with LLM settings via WebSocket
 */
export async function configureGateway(
  p: Prompter,
  state: WizardState
): Promise<boolean> {
  if (!state.deployment?.gatewayUrl) {
    p.error("No gateway URL available");
    return false;
  }

  const wsUrl = state.deployment.gatewayUrl
    .replace("https://", "wss://")
    .replace("http://", "ws://") + "/ws";

  const spinner = p.spinner("Configuring Gateway...");

  const client = new GatewayClient();

  try {
    // Wait for Gateway to be fully ready after deployment
    // Cloudflare can take a few seconds to propagate the new worker
    spinner.message("Waiting for Gateway to be ready...");
    await sleep(5000);

    // Connect WITHOUT auth first - fresh Gateway has no auth configured
    // This is intentional: we set auth.token via config.set after connecting
    await connectWithRetry(
      client,
      wsUrl,
      undefined, // No auth token - fresh deploy
      8,    // max attempts
      5000, // delay between attempts
      (attempt, max) => {
        spinner.message(`Connecting to Gateway (attempt ${attempt + 1}/${max})...`);
      },
    );

    // Set auth token FIRST - this secures the Gateway before setting other config
    // After this point, all connections must provide this token
    spinner.message("Setting auth token...");
    await client.configSet("auth.token", state.authToken);
    p.log(`✓ Set auth.token`);

    // Set model provider
    spinner.message("Setting model provider...");
    await client.configSet("model.provider", state.llm.provider);
    p.log(`✓ Set model.provider: ${state.llm.provider}`);

    // Set model ID
    spinner.message("Setting model...");
    await client.configSet("model.id", state.llm.model);
    p.log(`✓ Set model.id: ${state.llm.model}`);

    // Set API key
    spinner.message("Setting API key...");
    await client.configSet(`apiKeys.${state.llm.provider}`, state.llm.apiKey);
    p.log(`✓ Set apiKeys.${state.llm.provider}: ${state.llm.apiKey.slice(0, 8)}${state.llm.apiKey.length > 8 ? '...' : ''}`);

    // Set default channel configs
    if (state.channels.whatsapp) {
      spinner.message("Setting WhatsApp defaults...");
      // Default to pairing mode - safest option, requires approval for new senders
      await client.configSet("channels.whatsapp.dmPolicy", "pairing");
    }

    spinner.stop(pc.green("Gateway configured!"));
    
    client.close();
    return true;
  } catch (error) {
    spinner.stop(pc.red("Configuration failed"));
    client.close();
    
    const message = error instanceof Error ? error.message : String(error);
    p.error(`Failed to configure Gateway: ${message}`);
    
    // Show manual instructions as fallback
    p.note(
      `Run these commands to configure manually:\n\n` +
      `  gsv config set model.provider ${state.llm.provider}\n` +
      `  gsv config set model.id ${state.llm.model}\n` +
      `  gsv config set apiKeys.${state.llm.provider} <your-key>`,
      "Manual Configuration"
    );
    
    return false;
  }
}
