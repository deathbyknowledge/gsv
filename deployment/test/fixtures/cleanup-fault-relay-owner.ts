import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDeletionRequest, InstallationDeletionReceipt, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import type { InstallationDeletionDiscoveryService, InstallationDeletionInspection, InstallationDeletionInventoryImport } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { installationDeletionRequestSchema } from "@humansandmachines/gsv/services/lifecycle";
import { z } from "zod";

let calls = 0;
const committed = new Map<string, InstallationDeletionReceipt>();

/** Local test owner: commits an erase result before RPC returns to the real relay. */
export class TestOwner extends WorkerEntrypoint implements InstallationDeletionService, InstallationDeletionDiscoveryService {
  async callCount(): Promise<number> { return calls; }
  async eraseInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    calls++;
    if (input.operationId === "real_failure") throw new Error("Real owner failed");
    const result: InstallationDeletionReceipt = { ...input, phase: "live-erased", outcome: "retention-pending", pendingResources: 0,
      updatedAt: 1000, retainedCopies: [{ id: "backup", kind: "backup", expiresAt: 2000 }] };
    if (input.operationId === "wrong_receipt") result.installationId = "different";
    committed.set(JSON.stringify(input), result);
    return result;
  }
  async installationDeletionStatus(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    calls++;
    return committed.get(JSON.stringify(input)) ?? { ...input, phase: "pending", outcome: "progress", pendingResources: 1, updatedAt: 0, retainedCopies: [] };
  }
  async quiesceInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    calls++;
    return { ...input, phase: "quiesced", outcome: "progress", pendingResources: 1, updatedAt: 900, retainedCopies: [] };
  }
  async inspectInstallationDeletion(input: InstallationDeletionInspection) {
    calls++;
    return { installationId: input.installationId, observations: [] };
  }
  async importInstallationDeletionInventory(input: InstallationDeletionInventoryImport) {
    calls++;
    return { installationId: input.installationId, discoverySha256: input.discoverySha256, outcome: "verified" as const, verifiedAt: 1000 };
  }
}

type Relay = InstallationDeletionService & InstallationDeletionDiscoveryService;
type ProbeEnvironment = { AUTHORIZED: Relay; MISSING: Relay; WRONG: Relay; INVALID: Relay; OWNER: TestOwner };
export default class Probe extends WorkerEntrypoint<ProbeEnvironment> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/count") return Response.json(await this.env.OWNER.callCount());
    const input = z.object({ binding: z.enum(["AUTHORIZED", "MISSING", "WRONG", "INVALID"]),
      method: z.enum(["erase", "status", "quiesce", "inspect", "import"]), request: installationDeletionRequestSchema }).parse(await request.json());
    const relay = this.env[input.binding];
    // Catch inside the runtime so failed RPC serialization cannot change the test's error assertions.
    try {
      switch (input.method) {
        case "erase": return Response.json({ result: await relay.eraseInstallation(input.request) });
        case "status": return Response.json({ result: await relay.installationDeletionStatus(input.request) });
        case "quiesce": return Response.json({ result: await relay.quiesceInstallation(input.request) });
        case "inspect": return Response.json({ result: await relay.inspectInstallationDeletion({ installationId: input.request.installationId, resources: [] }) });
        case "import": return Response.json({ result: await relay.importInstallationDeletionInventory({ installationId: input.request.installationId, discoverySha256: "a".repeat(64), resources: [] }) });
      }
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }); }
  }
}
