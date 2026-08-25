import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { buildUserMcpOAuthCallbackPath } from "../shared/callback-routes";
import { SHIP_KERNEL_NAME, userKernelName } from "../shared/kernel-names";
import { Kernel } from "./do";
import {
  USER_KERNEL_INSTANCE_STORAGE_KEY,
  type UserKernelInstanceMarker,
} from "./user-kernels";

const OWNER_UID = 1000;
const SERVER_ID = "mcp-server-1";

type TestKernelInternals = {
  userKernelMarker: UserKernelInstanceMarker;
  mcpServers: {
    get(serverId: string): {
      serverId: string;
      uid: number;
      name: string;
      createdAt: number;
      updatedAt: number;
    } | null;
    list(): never[];
  };
  mcp: {
    isCallbackRequest(request: Request): boolean;
    handleCallbackRequest(request: Request): Promise<{
      authSuccess: boolean;
      serverId: string;
      authError?: string;
    }>;
    mcpConnections: Record<string, unknown>;
    establishConnection(serverId: string): Promise<void>;
    closeConnection(serverId: string): Promise<void>;
  };
  createMcpOAuthProvider(callbackUrl: string): any;
};

function marker(
  username: string,
  lifecycle: "provisioning" | "active" = "active",
): UserKernelInstanceMarker {
  return {
    version: 1,
    kind: "user",
    username,
    uid: OWNER_UID,
    lifecycle,
    updatedAt: Date.now(),
  } as UserKernelInstanceMarker;
}

async function newUserKernel(): Promise<{
  kernel: DurableObjectStub<Kernel>;
  username: string;
}> {
  const username = `mcp-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, userKernelName(username));
  await runInDurableObject(kernel, async (instance: Kernel, state) => {
    const active = marker(username);
    await state.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, active);
    (instance as unknown as TestKernelInternals).userKernelMarker = active;
  });
  return { kernel, username };
}

function callbackRequest(username: string): Request {
  return new Request(
    `https://gsv.test${buildUserMcpOAuthCallbackPath(username)}`
      + `?state=nonce.${SERVER_ID}&code=oauth-code`,
  );
}

function serverRecord() {
  return {
    serverId: SERVER_ID,
    uid: OWNER_UID,
    name: "Private MCP",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Master MCP runtime cutoff", () => {
  it("leaves old singleton MCP rows stored without restoring transports", async () => {
    const master = await getAgentByName<Env, Kernel>(env.KERNEL, SHIP_KERNEL_NAME);

    await runInDurableObject(master, async (instance: Kernel, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_mcp_servers (
           id, name, server_url, callback_url, client_id, auth_url, server_options
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
        "old-http-server",
        "Old HTTP Server",
        "https://mcp.example.test",
        "https://gsv.test/oauth/callback",
      );
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO cf_agents_mcp_servers (
           id, name, server_url, callback_url, client_id, auth_url, server_options
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
        "old-rpc-server",
        "Old RPC Server",
        "rpc://old-server",
        "",
        JSON.stringify({ bindingName: "OLD_MCP" }),
      );

      const mcp = (instance as any).mcp;
      await expect(mcp.restoreConnectionsFromStorage(SHIP_KERNEL_NAME))
        .resolves.toBeUndefined();
      expect(mcp.getRpcServersFromStorage()).toEqual([]);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_agents_mcp_servers",
      ).one().count).toBe(2);
    });
  });
});

describe("Kernel MCP OAuth callback admission", () => {
  it("denies an inactive user Kernel before callback state processing", async () => {
    const { kernel, username } = await newUserKernel();

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const internals = instance as unknown as TestKernelInternals;
      const inactive = marker(username, "provisioning");
      await state.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, inactive);
      internals.userKernelMarker = inactive;

      const handleCallbackRequest = vi.fn(async () => ({
        authSuccess: true,
        serverId: SERVER_ID,
      }));
      internals.mcpServers = {
        get: vi.fn((serverId: string) => serverId === SERVER_ID ? serverRecord() : null),
        list: vi.fn(() => []),
      };
      internals.mcp = {
        isCallbackRequest: vi.fn(() => true),
        handleCallbackRequest,
        mcpConnections: {},
        establishConnection: vi.fn(async () => undefined),
        closeConnection: vi.fn(async () => undefined),
      };

      const response = await instance.onRequest(callbackRequest(username));

      expect(response.status).toBe(409);
      await expect(response.text()).resolves.toContain(
        "MCP OAuth session is no longer active",
      );
      expect(handleCallbackRequest).not.toHaveBeenCalled();
    });
  });

  it("commits provider tokens only while the durable owner marker is active", async () => {
    const { kernel, username } = await newUserKernel();

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const internals = instance as unknown as TestKernelInternals;
      const provider = internals.createMcpOAuthProvider(
        `https://gsv.test${buildUserMcpOAuthCallbackPath(username)}`,
      );
      provider.serverId = SERVER_ID;
      provider.clientId = "active-client";

      await provider.saveTokens({
        access_token: "active-private-token",
        token_type: "Bearer",
      });
      await expect(state.storage.get(provider.tokenKey("active-client")))
        .resolves.toMatchObject({ access_token: "active-private-token" });

      const inactive = marker(username, "provisioning");
      await state.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, inactive);
      internals.userKernelMarker = inactive;
      provider.clientId = "blocked-client";

      await expect(provider.saveTokens({
        access_token: "blocked-private-token",
        token_type: "Bearer",
      })).rejects.toThrow("User Kernel is not active");
      await expect(state.storage.get(provider.tokenKey("blocked-client")))
        .resolves.toBeUndefined();
    });
  });

  it("denies late writes after a cancelled callback invalidates its local epoch", async () => {
    const { kernel, username } = await newUserKernel();

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const internals = instance as unknown as TestKernelInternals;
      const provider = internals.createMcpOAuthProvider(
        `https://gsv.test${buildUserMcpOAuthCallbackPath(username)}`,
      );
      provider.serverId = SERVER_ID;
      provider.clientId = "existing-client";

      const operation = new AbortController();
      provider.setCallbackOperationSignal(operation.signal);
      let resumeLateCallback!: () => void;
      const lateCallbackGate = new Promise<void>((resolve) => {
        resumeLateCallback = resolve;
      });
      let finishLateCallback!: (
        results: PromiseSettledResult<unknown>[],
      ) => void;
      const lateCallbackFinished = new Promise<PromiseSettledResult<unknown>[]>((resolve) => {
        finishLateCallback = resolve;
      });

      const callback = provider.runWithCodeVerifierState(
        `nonce.${SERVER_ID}`,
        async () => {
          await lateCallbackGate;
          const results = await Promise.allSettled([
            provider.saveTokens({
              access_token: "late-private-token",
              token_type: "Bearer",
            }),
            provider.saveClientInformation({
              client_id: "late-client",
              client_name: "Late Client",
              redirect_uris: [provider.redirectUrl],
            }),
          ]);
          finishLateCallback(results);
          return results;
        },
      );

      operation.abort(new Error("callback cancelled"));
      await expect(callback).rejects.toThrow("callback cancelled");
      resumeLateCallback();
      const results = await lateCallbackFinished;

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toEqual(
            new Error("MCP OAuth session is no longer active"),
          );
        }
      }
      await expect(state.storage.get(provider.tokenKey("existing-client")))
        .resolves.toBeUndefined();
      await expect(state.storage.get(provider.clientInfoKey("late-client")))
        .resolves.toBeUndefined();
    });
  });
});
