import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ManagedSlackPeerEnv } from "../src/managed-peer";
import type { ManagedSlackPeerState } from "../src/managed-peer-state";
import type { SlackLifecycleEntrypoint } from "../src/lifecycle";
import { managedSlackPeerObjectName, managedSlackWorkspaceObjectName } from "../src/managed-identity";
import { workspaceAccountId } from "../src/slack-api";
import { inspectAdapterHilOwnership } from "../../shared/src/hil-approval";

// SAFETY: the fixture binds these concrete Workers and namespaces.
const bindings = env as ManagedSlackPeerEnv & { LIFECYCLE: Service<SlackLifecycleEntrypoint> };
const stateKey = "managed_slack_peer:v1:state";
const botScopes = "app_mentions:read,chat:write,chat:write.public,files:read,files:write,im:history,im:write,reactions:write";
const userScopes = "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read";

describe("Slack installation retirement through the owning Worker", () => {
  it("imports the physical account, peer, and claim and preserves the shared app and other person's route", async () => {
    const teamId = "TRETIREJOURNEY";
    const accountId = await workspaceAccountId(teamId);
    const workspaceName = managedSlackWorkspaceObjectName(accountId);
    const workspace = bindings.MANAGED_SLACK_WORKSPACE.getByName(workspaceName);
    const installationId = "retired-slack-journey";
    const request = { version: 1 as const, installationId, operationId: "retire-slack-journey" };
    async function pair(actorId: string, space: string) {
      const installed = await workspace.install(accountId, { teamId, botUserId: "UBOTGSV1", botToken: "xoxb-journey-fixture", scope: botScopes, user: { id: actorId, token: "xoxp-journey-fixture", scope: userScopes } });
      if (!installed.accepted) throw new Error("Expected workspace installation");
      const peerName = managedSlackPeerObjectName(accountId, actorId);
      const peer = bindings.MANAGED_SLACK_PEER.getByName(peerName);
      await peer.acceptEvent({ accountId, teamId, botUserId: "UBOTGSV1", workspaceGeneration: installed.generation, inbound: {
        deliveryId: `first-${actorId}`, eventId: `event-${actorId}`, teamId, messageId: "1700000000.000100", actorId,
        surface: { kind: "dm", id: actorId === "UALICE01" ? "DALICE01" : "DBOB0001" }, text: "pair", wasMentioned: true,
      } });
      await vi.waitFor(async () => expect(await runInDurableObject(peer, async (_instance, state) => (await state.storage.get<ManagedSlackPeerState>(stateKey))?.pairing?.code)).toBeTruthy());
      const state = await runInDurableObject(peer, async (_instance, state) => (await state.storage.get<ManagedSlackPeerState>(stateKey))!);
      const pending = state.pairing!;
      const claimName = `pair:${pending.code}`;
      const claim = bindings.MANAGED_SLACK_PAIRING.getByName(claimName);
      const input = { code: pending.code, installationId: space, localUid: 1000, operationId: `pair-${actorId}`, canonicalOrigin: "https://fixture.gsv.space" };
      const prepared = await claim.prepare(input);
      await expect((async () => await claim.prepare({ ...input, localUid: 1001 }))()).rejects.toThrow("identity changed");
      const activate = { code: pending.code, operationId: input.operationId, route: prepared.route, canonicalOrigin: input.canonicalOrigin };
      await claim.activate(activate);
      await claim.finalize(activate);
      return { peer, claim, peerName, claimName, route: prepared.route, state };
    }
    const own = await pair("UALICE01", installationId);
    const other = await pair("UBOB0001", "preserved-slack-journey");
    const context = {
      deliveryId: "slack-retirement-hil", accountId, actorId: "UALICE01", surface: { kind: "dm" as const, id: own.state.dmSurfaceId! },
      routeGeneration: own.route.generation, processId: "child-fixture", runId: "run-fixture", processMode: "work" as const,
      hil: { pid: "child-fixture", requestId: "retirement-approval", runId: "run-fixture", callId: "call-fixture", toolName: "Shell", syscall: "shell.exec", target: "gsv", args: { input: "date" }, createdAt: Date.now() },
    };
    expect(await own.peer.sendMessage(installationId, { deliveryId: context.deliveryId, surface: context.surface, actorId: context.actorId, routeGeneration: own.route.generation, text: "" }, undefined, context)).toMatchObject({ ok: true });
    await runInDurableObject(own.peer, async (_instance, state) => expect(await inspectAdapterHilOwnership(state.storage, installationId)).toMatchObject({ ownedCount: 1 }));
    await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources: [] });
    const resources = [
      { kind: "adapter-installation" as const, name: installationId, objectId: bindings.SLACK_INSTALLATIONS.idFromName(installationId).toString(), namespaceId: "1".repeat(32) },
      { kind: "adapter-account" as const, name: workspaceName, objectId: bindings.MANAGED_SLACK_WORKSPACE.idFromName(workspaceName).toString(), namespaceId: "2".repeat(32) },
      { kind: "adapter-peer" as const, name: own.peerName, objectId: bindings.MANAGED_SLACK_PEER.idFromName(own.peerName).toString(), namespaceId: "3".repeat(32) },
      { kind: "adapter-pairing" as const, name: own.claimName, objectId: bindings.MANAGED_SLACK_PAIRING.idFromName(own.claimName).toString(), namespaceId: "4".repeat(32) },
    ];
    expect(await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources })).toMatchObject({ observations: resources.map((resource) => ({ ...resource, outcome: "identified", installationId })) });
    expect(await bindings.LIFECYCLE.importInstallationDeletionInventory({ installationId, discoverySha256: "a".repeat(64), resources })).toMatchObject({ outcome: "verified" });
    await vi.waitFor(async () => {
      await bindings.LIFECYCLE.quiesceInstallation(request);
      expect(await bindings.LIFECYCLE.eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
    });
    await runInDurableObject(own.peer, async (_instance, state) => {
      expect(await inspectAdapterHilOwnership(state.storage, installationId)).toMatchObject({ ownedCount: 0 });
      expect((await state.storage.get<ManagedSlackPeerState>(stateKey))?.activeRoute).toBeUndefined();
    });
    expect(await own.claim.inspectInstallationResource(installationId)).toMatchObject({ outcome: "empty" });
    expect(await workspace.getStatus()).toMatchObject({ connected: true });
    expect(await workspace.getTargetAuthorization("UALICE01", own.state.workspaceGeneration)).toMatchObject({ available: false });
    expect(await workspace.getTargetAuthorization("UBOB0001", other.state.workspaceGeneration)).toMatchObject({ available: true });
    expect(await other.peer.sendMessage(other.route.installationId, { deliveryId: "preserved-after-retirement", surface: { kind: "dm", id: other.state.dmSurfaceId! }, actorId: "UBOB0001", routeGeneration: other.route.generation, text: "preserved" })).toMatchObject({ ok: true });
  });
});
