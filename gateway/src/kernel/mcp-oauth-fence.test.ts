import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { buildUserMcpOAuthCallbackPath } from "../shared/callback-routes";
import { userKernelName } from "../shared/kernel-names";
import { Kernel } from "./do";
import {
  USER_KERNEL_INSTANCE_STORAGE_KEY,
  type UserKernelInstanceMarker,
} from "./user-kernels";

const OWNER_UID = 1000;
const GENERATION = 7;
const SERVER_ID = "mcp-server-1";

type TestKernelInternals = {
  userKernelMarker: UserKernelInstanceMarker;
  appRuntimes: {
    beginLifecycleFence(input: {
      ownerUid: number;
      ownerUsername: string;
      sourceKernelName: string;
      generation: number;
      fenceId: string;
      targetLifecycle: "suspended";
      createdAt: number;
    }): unknown;
  };
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
  closeUserKernelTargetAdmission(
    generation: number,
    reason: string,
  ): void;
};

function activeMarker(username: string, generation = GENERATION): UserKernelInstanceMarker {
  return {
    version: 1,
    kind: "user",
    username,
    uid: OWNER_UID,
    generation,
    lifecycle: "active",
    updatedAt: Date.now(),
  };
}

async function newUserKernel(): Promise<{
  kernel: DurableObjectStub<Kernel>;
  kernelName: string;
  username: string;
}> {
  const username = `mcp-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const kernelName = userKernelName(username);
  const kernel = await getAgentByName<Env, Kernel>(env.KERNEL, kernelName);
  await runInDurableObject(kernel, async (instance: Kernel, state) => {
    const marker = activeMarker(username);
    await state.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, marker);
    (instance as unknown as TestKernelInternals).userKernelMarker = marker;
  });
  return { kernel, kernelName, username };
}

function callbackRequest(username: string): Request {
  return new Request(
    `https://gsv.test${buildUserMcpOAuthCallbackPath(username, GENERATION)}`
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

describe("Kernel MCP OAuth callback fencing", () => {
  it("runs the Agents callback hook through the Kernel shadow and denies before state processing", async () => {
    const { kernel, kernelName, username } = await newUserKernel();

    await runInDurableObject(kernel, async (instance: Kernel) => {
      const internals = instance as unknown as TestKernelInternals;
      const hook = Object.getOwnPropertyDescriptor(instance, "handleMcpOAuthCallback");
      expect(hook).toMatchObject({
        configurable: false,
        enumerable: false,
        writable: false,
      });
      expect(hook?.value).toBeTypeOf("function");

      internals.appRuntimes.beginLifecycleFence({
        ownerUid: OWNER_UID,
        ownerUsername: username,
        sourceKernelName: kernelName,
        generation: GENERATION,
        fenceId: crypto.randomUUID(),
        targetLifecycle: "suspended",
        createdAt: Date.now(),
      });

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

  it("rejects an in-flight callback after its Kernel generation is fenced", async () => {
    const { kernel, username } = await newUserKernel();

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const internals = instance as unknown as TestKernelInternals;
      let resolveCallback!: (result: {
        authSuccess: true;
        serverId: string;
      }) => void;
      let markCallbackStarted!: () => void;
      const callbackStarted = new Promise<void>((resolve) => {
        markCallbackStarted = resolve;
      });
      const callbackResult = new Promise<{
        authSuccess: true;
        serverId: string;
      }>((resolve) => {
        resolveCallback = resolve;
      });
      const establishConnection = vi.fn(async () => undefined);
      const closeConnection = vi.fn(async () => undefined);
      internals.mcpServers = {
        get: vi.fn((serverId: string) => serverId === SERVER_ID ? serverRecord() : null),
        list: vi.fn(() => []),
      };
      internals.mcp = {
        isCallbackRequest: vi.fn(() => true),
        handleCallbackRequest: vi.fn(() => {
          markCallbackStarted();
          return callbackResult;
        }),
        mcpConnections: {},
        establishConnection,
        closeConnection,
      };

      const responsePromise = instance.onRequest(callbackRequest(username));
      await callbackStarted;
      internals.closeUserKernelTargetAdmission(GENERATION, "generation changed");
      const replacement = activeMarker(username, GENERATION + 1);
      await state.storage.put(USER_KERNEL_INSTANCE_STORAGE_KEY, replacement);
      internals.userKernelMarker = replacement;
      resolveCallback({ authSuccess: true, serverId: SERVER_ID });

      const response = await responsePromise;
      expect(response.status).toBe(409);
      expect(establishConnection).not.toHaveBeenCalled();
      expect(closeConnection).toHaveBeenCalledExactlyOnceWith(SERVER_ID);
    });
  });

  it("denies token and client writes resumed after callback abort invalidates the epoch", async () => {
    const { kernel, username } = await newUserKernel();

    await runInDurableObject(kernel, async (instance: Kernel, state) => {
      const provider = instance.createMcpOAuthProvider(
        `https://gsv.test${buildUserMcpOAuthCallbackPath(username, GENERATION)}`,
      ) as any;
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

      operation.abort(new Error("callback generation fenced"));
      await expect(callback).rejects.toThrow("callback generation fenced");
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
      await expect(state.storage.get(
        provider.tokenKey("existing-client"),
      )).resolves.toBeUndefined();
      await expect(state.storage.get(
        provider.clientInfoKey("late-client"),
      )).resolves.toBeUndefined();
    });
  });
});
