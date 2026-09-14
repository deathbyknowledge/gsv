import { env, runInDurableObject } from "cloudflare:test";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { workspaceAccountId } from "../src/slack-api";
import { managedSlackWorkspaceObjectName } from "../src/managed-identity";
import type { ManagedSlackWorkspace } from "../src/managed-workspace";

const botScopes = "app_mentions:read,chat:write,chat:write.public,files:read,files:write,im:history,im:write,reactions:write";
const userScopes = "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read";
const userPrefix = "managed_slack_workspace:v1:user:";
const routePrefix = "managed_slack_workspace:v1:route:";
const cachePrefix = "managed_slack_workspace:v1:dm:";
type WorkspaceTestBindings = { MANAGED_SLACK_WORKSPACE: DurableObjectNamespace<ManagedSlackWorkspace> };
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const teamId = `T${crypto.randomUUID().replaceAll("-", "").slice(0, 30).toUpperCase()}`;
  const accountId = await workspaceAccountId(teamId);
  // SAFETY: the managed test configuration binds this namespace to ManagedSlackWorkspace.
  const namespace = (env as typeof env & WorkspaceTestBindings).MANAGED_SLACK_WORKSPACE;
  const workspace = namespace.getByName(managedSlackWorkspaceObjectName(accountId));
  const install = (actorId: string, botToken = "xoxb-workspace-retirement-bot") => workspace.install(accountId, { teamId, botUserId: "UBOTGSV1", botToken, scope: botScopes,
    user: { id: actorId, token: "xoxp-workspace-retirement-user", scope: userScopes } });
  const installationId = `space-${crypto.randomUUID()}`;
  const other = `space-${crypto.randomUUID()}`;
  const input = { version: 1 as const, installationId, operationId: "delete-workspace-owner" };
  const installed = await install("UALICE01");
  if (!installed.accepted) throw new Error("Fixture workspace was not installed");
  return { workspace, install, input, other, generation: installed.generation, accountId, teamId };
}

describe("shared Slack workspace retirement", () => {
  it("rejects a slow route registration after another space changed the actor route", async () => {
    const f = await fixture();
    await runInDurableObject(f.workspace, async (instance) => {
      const original = instance["registerOwnership"].bind(instance);
      const entered = barrier();
      const released = barrier();
      instance["registerOwnership"] = async (owner, accountId) => {
        await original(owner, accountId);
        if (owner.installationId === f.input.installationId) { entered.resolve(); await released.promise; }
      };
      try {
        const slow = instance.registerPeerRoute("UALICE01", f.input.installationId, "slow-a").then(() => "accepted", (error: Error) => error.message);
        await entered.promise;
        await instance.registerPeerRoute("UALICE01", f.other, "fast-b");
        released.resolve();
        expect(await slow).toContain("route changed");
      } finally { released.resolve(); instance["registerOwnership"] = original; }
    });
    await runInDurableObject(f.workspace, (_instance, state) => {
      expect(state.storage.kv.get(`${routePrefix}UALICE01`)).toMatchObject({ installationId: f.other, routeGeneration: "fast-b" });
      expect(state.storage.kv.get(`${userPrefix}UALICE01`)).toMatchObject({ owner: { installationId: f.other, generation: "fast-b" } });
    });
  });

  it("rejects an older OAuth install when a newer app installation commits during index registration", async () => {
    const f = await fixture();
    await f.workspace.registerPeerRoute("UALICE01", f.input.installationId, "route-a");
    await runInDurableObject(f.workspace, async (instance) => {
      const original = instance["registerOwnership"].bind(instance);
      const entered = barrier();
      const released = barrier();
      instance["registerOwnership"] = async (owner, accountId) => {
        await original(owner, accountId);
        if (owner.installationId === f.input.installationId) { entered.resolve(); await released.promise; }
      };
      try {
        const slow = instance.install(f.accountId, { teamId: f.teamId, botUserId: "UBOTGSV1", botToken: "xoxb-older-install", scope: botScopes,
          user: { id: "UALICE01", token: "xoxp-older-user-token", scope: userScopes } }).then(() => "accepted", (error: Error) => error.message);
        await entered.promise;
        await instance.install(f.accountId, { teamId: f.teamId, botUserId: "UBOTGSV1", botToken: "xoxb-newer-install", scope: botScopes,
          user: { id: "UBOB0001", token: "xoxp-newer-user-token", scope: userScopes } });
        released.resolve();
        expect(await slow).toContain("workspace changed");
      } finally { released.resolve(); instance["registerOwnership"] = original; }
    });
    await runInDurableObject(f.workspace, (_instance, state) => {
      expect(state.storage.kv.get("managed_slack_workspace:v1:state")).toMatchObject({ botToken: "xoxb-newer-install" });
    });
  });

  it("erases one user's routes, credentials, and cache while preserving the app and another space across restart", async () => {
    const f = await fixture();
    await f.workspace.registerPeerRoute("UALICE01", f.input.installationId, "route-a");
    await f.install("UBOB0001");
    await f.workspace.registerPeerRoute("UBOB0001", f.other, "route-b");
    await f.workspace.openDm("UALICE01", f.generation, { installationId: f.input.installationId, generation: "route-a" });
    await f.workspace.openDm("UBOB0001", f.generation, { installationId: f.other, generation: "route-b" });
    expect(await f.workspace.inspectInstallationResource(f.input.installationId)).toMatchObject({ outcome: "identified", installationId: f.input.installationId });
    expect(await f.workspace.eraseInstallation(f.input)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
    await evictDurableObject(f.workspace);
    expect(await f.workspace.getTargetAuthorization("UBOB0001", f.generation)).toMatchObject({ available: true });
    expect(await f.workspace.getTargetAuthorization("UALICE01", f.generation)).toEqual({ available: false });
    expect(await f.workspace.getStatus()).toMatchObject({ connected: true, generation: f.generation });
    await runInDurableObject(f.workspace, (_instance, state) => {
      expect(state.storage.kv.get(`${userPrefix}UALICE01`)).toBeUndefined();
      expect(state.storage.kv.get(`${routePrefix}UALICE01`)).toBeUndefined();
      expect(state.storage.kv.get(`${cachePrefix}UALICE01`)).toBeUndefined();
      expect(state.storage.kv.get(`${userPrefix}UBOB0001`)).toMatchObject({ owner: { installationId: f.other, generation: "route-b" } });
    });
    await runInDurableObject(f.workspace, async (instance) => {
      await expect(instance.registerPeerRoute("UALICE01", f.input.installationId, "late-route")).rejects.toThrow("retired");
      await expect(instance.postMessage(f.generation, { channel: "CGENERAL1", text: "late" }, { installationId: f.input.installationId, generation: "route-a" })).rejects.toThrow("retired");
    });
  });

  it("keeps legacy unowned credentials unidentified until an exact durable actor route proves ownership", async () => {
    const f = await fixture();
    expect((await f.workspace.inspectInstallationResource(f.input.installationId)).outcome).toBe("unrelated");
    await runInDurableObject(f.workspace, (_instance, state) => {
      const credential = state.storage.kv.get<{ owner?: null }>(`${userPrefix}UALICE01`)!;
      delete credential.owner;
      state.storage.kv.put(`${userPrefix}UALICE01`, credential);
    });
    expect((await f.workspace.inspectInstallationResource(f.input.installationId)).outcome).toBe("unidentified");
    expect((await f.workspace.eraseInstallation(f.input)).outcome).toBe("missing-inventory");
    await runInDurableObject(f.workspace, (_instance, state) => {
      state.storage.kv.put(`${routePrefix}UALICE01`, { version: 1, actorId: "UALICE01", installationId: f.input.installationId, routeGeneration: "historical" });
    });
    expect((await f.workspace.inspectInstallationResource(f.input.installationId)).outcome).toBe("identified");
    await f.workspace.unregisterPeerRoute("UALICE01", f.input.installationId, "historical");
    expect((await f.workspace.inspectInstallationResource(f.input.installationId)).outcome).toBe("identified");
    expect((await f.workspace.eraseInstallation(f.input)).phase).toBe("live-erased");
  });

  it("cancels a target operation owned by the retired space and still admits another space's read", async () => {
    const f = await fixture();
    await f.workspace.registerPeerRoute("UALICE01", f.input.installationId, "route-a");
    await f.install("UBOB0001");
    await f.workspace.registerPeerRoute("UBOB0001", f.other, "route-b");
    const cursor = btoa("wait-for-fs-cancel").replace(/=+$/, "");
    const pending = runInDurableObject(f.workspace, (instance) => instance.executeTarget("UALICE01", f.generation, { type: "req", id: "retirement-cancel", call: "fs.read",
      args: { path: `/conversations/pages/${cursor}.json` }, deadlineAt: Date.now() + 120_000 }));
    await vi.waitFor(async () => {
      // Active work is itself part of the lifecycle receipt before the fence starts.
      expect((await f.workspace.installationDeletionStatus(f.input)).pendingResources).toBeGreaterThan(2);
    });
    await f.workspace.quiesceInstallation(f.input);
    expect(await f.workspace.getTargetAuthorization("UALICE01", f.generation)).toEqual({ available: false });
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ ok: false, error: { code: 499 } });
    expect((await f.workspace.eraseInstallation(f.input)).phase).toBe("live-erased");
    expect(await runInDurableObject(f.workspace, async (instance) => {
      const next = await instance.executeTarget("UBOB0001", f.generation, { type: "req", id: "other-read", call: "fs.read", args: { path: "/workspace.json" }, deadlineAt: Date.now() + 120_000 });
      if (next.ok) await next.body?.stream.cancel();
      return next.ok;
    })).toBe(true);
  });

  it("erases bounded batches and keeps attributed credentials when their actor has moved to another space", async () => {
    const f = await fixture();
    await f.workspace.registerPeerRoute("UALICE01", f.input.installationId, "old");
    await f.workspace.registerPeerRoute("UALICE01", f.other, "new");
    await runInDurableObject(f.workspace, (_instance, state) => {
      for (let index = 0; index < 33; index++) {
        const actorId = `UACTOR${index}`;
        state.storage.kv.put(`${routePrefix}${actorId}`, { version: 1, actorId, installationId: f.input.installationId, routeGeneration: "old" });
        state.storage.kv.put(`${cachePrefix}${actorId}`, { generation: f.generation, channelId: "DGENERAL1", owner: { installationId: f.input.installationId, generation: "old" } });
      }
    });
    expect(await f.workspace.eraseInstallation(f.input)).toMatchObject({ phase: "erasing", pendingResources: 34 });
    await evictDurableObject(f.workspace);
    expect(await f.workspace.eraseInstallation(f.input)).toMatchObject({ phase: "erasing", pendingResources: 2 });
    expect(await f.workspace.eraseInstallation(f.input)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect(await f.workspace.getTargetAuthorization("UALICE01", f.generation)).toMatchObject({ available: true });
  });
});
