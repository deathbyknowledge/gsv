import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { SharedDiscordEnv } from "../src/shared-application";
import type { DiscordLifecycleEntrypoint } from "../src/lifecycle";
import { adapterAccountDurableObjectName } from "../../shared/src/installation";
import { DeliveryLedger } from "../../shared/src/delivery-ledger";

// SAFETY: the shared Wrangler fixture retains the concrete legacy namespace and lifecycle entrypoint.
const bindings = env as SharedDiscordEnv & { LIFECYCLE: Service<DiscordLifecycleEntrypoint> };
async function legacyAccount(installationId: string, accountId = "default") {
  const name = adapterAccountDurableObjectName({ installationId }, accountId);
  const namespace = bindings.DISCORD_GATEWAY!;
  const stub = namespace.getByName(name);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("state", { accountId, botToken: "synthetic-retained-token", sessionId: "retained-session", resumeGatewayUrl: null, seq: 7, connected: false, lastHeartbeatAck: null, lastError: null });
    const deliveries = new DeliveryLedger(state.storage);
    const claim = await deliveries.claim("historical-send", "a".repeat(64));
    if (!claim.claimed) throw new Error("Expected fresh historical receipt");
    await deliveries.succeed("historical-send", claim.attemptId, "old-provider-receipt");
  });
  return { stub, resource: { kind: "adapter-account" as const, name, objectId: namespace.idFromName(name).toString(), namespaceId: "1".repeat(32) } };
}

describe("legacy Discord account lifecycle composition", () => {
  it("recovers physical scope from trusted candidates and retires one account without touching another", async () => {
    const installationId = "retired-legacy-lifecycle";
    const own = await legacyAccount(installationId);
    const other = await legacyAccount("other-legacy-lifecycle");
    await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources: [] });
    const probe = ({ objectId, kind, namespaceId }: typeof own.resource) => ({ objectId, kind, namespaceId });
    expect(await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources: [probe(own.resource), probe(other.resource)], candidateInstallationIds: ["other-legacy-lifecycle"] })).toMatchObject({ observations: [
      { ...own.resource, outcome: "identified", installationId },
      { ...other.resource, outcome: "unrelated" },
    ] });
    const self = { kind: "adapter-installation" as const, name: installationId, objectId: bindings.DISCORD_INSTALLATIONS.idFromName(installationId).toString(), namespaceId: "2".repeat(32) };
    expect(await bindings.LIFECYCLE.importInstallationDeletionInventory({ installationId, discoverySha256: "b".repeat(64), resources: [self, own.resource] })).toMatchObject({ outcome: "verified" });
    const request = { version: 1 as const, installationId, operationId: "legacy-retirement" };
    await vi.waitFor(async () => {
      await bindings.LIFECYCLE.quiesceInstallation(request);
      expect(await bindings.LIFECYCLE.eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
    });
    await runInDurableObject(own.stub, async (instance, state) => {
      expect(await state.storage.get("state")).toBeUndefined();
      expect((await state.storage.list({ prefix: "outbound_delivery:v1:record:" })).size).toBe(0);
      await expect(instance.start("synthetic-late-token", "default")).rejects.toThrow("retired");
      expect(await state.storage.get("state")).toBeUndefined();
    });
    await runInDurableObject(other.stub, async (_instance, state) => {
      expect(await state.storage.get("state")).toMatchObject({ accountId: "default", botToken: "synthetic-retained-token" });
      expect((await state.storage.list({ prefix: "outbound_delivery:v1:record:" })).size).toBe(1);
    });
  });

  it("does not turn a caller-supplied unknown installation into trusted ownership evidence", async () => {
    const unknown = await legacyAccount("missing-legacy-owner");
    const inspection = await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId: "retired-legacy-inspection", resources: [{ kind: unknown.resource.kind, objectId: unknown.resource.objectId, namespaceId: unknown.resource.namespaceId }], candidateInstallationIds: ["missing-legacy-owner"] });
    expect(inspection.observations).toEqual([{ kind: unknown.resource.kind, objectId: unknown.resource.objectId, namespaceId: unknown.resource.namespaceId, outcome: "unidentified" }]);
    await runInDurableObject(unknown.stub, async (_instance, state) => expect(await state.storage.get("state")).toMatchObject({ accountId: "default" }));
  });

  it("preserves a standalone account whose old local name resembles a managed scoped name", async () => {
    const installationId = "retired-scoped-lookalike";
    const accountId = adapterAccountDurableObjectName({ installationId }, "default");
    const standalone = await legacyAccount("singleton", accountId);
    const result = await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources: [{ kind: standalone.resource.kind, objectId: standalone.resource.objectId, namespaceId: standalone.resource.namespaceId }] });
    expect(result.observations).toEqual([{ ...standalone.resource, outcome: "unrelated" }]);
  });
});
