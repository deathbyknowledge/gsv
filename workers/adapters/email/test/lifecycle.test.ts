import { env } from "cloudflare:workers";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import type { InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import type { InstallationDeletionDiscoveryService } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { describe, expect, it } from "vitest";
import type { MailEnv } from "../src/env";

type Lifecycle = InstallationDeletionService & Pick<InstallationDeletionDiscoveryService, "inspectInstallationDeletion">;
// SAFETY: the actual Wrangler test service bindings supply the mail lifecycle entrypoint.
const rawBindings: unknown = env;
// SAFETY: bindings are exercised over actual Worker RPC below.
const bindings = rawBindings as MailEnv & { MAIL_LIFECYCLE: Lifecycle; MAIL_UNAUTHORIZED: Lifecycle };
const request = (installationId: string) => ({ version: 1 as const, installationId, operationId: `delete:${installationId}` });

describe("mail lifecycle authority and physical discovery", () => {
  it("requires trusted binding props and retired directory state before allocating an owner", async () => {
    const before = (await listDurableObjectIds(bindings.MAIL_INSTALLATIONS)).map(String);
    await expect(async () => await bindings.MAIL_UNAUTHORIZED.quiesceInstallation(request("installation_retained_denied"))).rejects.toThrow("authority");
    await expect(async () => await bindings.MAIL_LIFECYCLE.quiesceInstallation(request("installation_active_denied"))).rejects.toThrow("retired");
    await expect(async () => await bindings.MAIL_LIFECYCLE.quiesceInstallation(request("unknown"))).rejects.toThrow("retired");
    expect((await listDurableObjectIds(bindings.MAIL_INSTALLATIONS)).map(String)).toEqual(before);
  });

  it("maps verified directory identities without opening unknown object ids and completes a clean retirement", async () => {
    const installationId = "installation_retained_lifecycle";
    const stub = bindings.MAIL_INSTALLATIONS.getByName(installationId);
    await stub.usage();
    const resource = { kind: "mail" as const, objectId: stub.id.toString(), namespaceId: "a".repeat(32), name: installationId };
    const otherId = "installation_other_lifecycle";
    const other = bindings.MAIL_INSTALLATIONS.getByName(otherId);
    await other.usage();
    const unknownId = bindings.MAIL_INSTALLATIONS.idFromName("not-in-directory").toString();
    const before = (await listDurableObjectIds(bindings.MAIL_INSTALLATIONS)).map(String);
    const inspected = await bindings.MAIL_LIFECYCLE.inspectInstallationDeletion({
      installationId,
      resources: [resource, { kind: "mail", objectId: unknownId }, { kind: "mail", objectId: other.id.toString() }],
      candidateInstallationIds: ["not-in-directory", otherId],
    });
    expect(inspected.observations).toMatchObject([
      { ...resource, outcome: "identified", installationId },
      { objectId: unknownId, outcome: "unidentified" },
      { objectId: other.id.toString(), outcome: "identified", installationId: otherId },
    ]);
    expect((await listDurableObjectIds(bindings.MAIL_INSTALLATIONS)).map(String)).toEqual(before);
    expect(await bindings.MAIL_LIFECYCLE.quiesceInstallation(request(installationId))).toMatchObject({ phase: "quiesced" });
    expect(await bindings.MAIL_LIFECYCLE.eraseInstallation(request(installationId))).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
  });

  it("refuses a verified claim when the object holds unrecognized state", async () => {
    const installationId = "installation_retained_unrecognized";
    const stub = bindings.MAIL_INSTALLATIONS.getByName(installationId);
    await runInDurableObject(stub, (_instance, state) => state.storage.kv.put("unrecognized-owner-state", "fixture"));
    const resource = { kind: "mail" as const, objectId: stub.id.toString(), namespaceId: "a".repeat(32), name: installationId };
    expect(await bindings.MAIL_LIFECYCLE.inspectInstallationDeletion({ installationId, resources: [resource] })).toMatchObject({ observations: [{ outcome: "unidentified" }] });
    expect(await bindings.MAIL_LIFECYCLE.eraseInstallation(request(installationId))).toMatchObject({ outcome: "missing-inventory" });
    await runInDurableObject(stub, (_instance, state) => expect(state.storage.kv.get("unrecognized-owner-state")).toBe("fixture"));
  });
});
