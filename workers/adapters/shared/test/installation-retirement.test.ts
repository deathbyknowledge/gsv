import { describe, expect, it, vi } from "vitest";
import type { InstallationDeletionReceipt, InstallationDeletionRequest, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { AdapterInstallationRetirement, type AdapterInstallationResource, type AdapterInstallationRetirementOptions } from "../src/installation-retirement";
import { runAdapterInstallationSqlMigrations } from "../src/schema/installation-migrations";
import { TestDurableObjectStorage } from "./sqlite-storage";

const objectId = (index: number) => index.toString(16).padStart(64, "0");
const lifetime = 30 * 24 * 60 * 60_000 + 60_000;
const resource = (index: number): AdapterInstallationResource & { kind: "adapter-peer" } => ({ kind: "adapter-peer", name: `peer-${index}`, objectId: objectId(index), namespaceId: "a".repeat(32) });
function receipt(input: InstallationDeletionRequest, phase: InstallationDeletionReceipt["phase"], expiresAt = 1): InstallationDeletionReceipt {
  return { ...input, phase, updatedAt: 1, pendingResources: phase === "erased" ? 0 : 1,
    outcome: phase === "erased" ? "complete" : phase === "live-erased" ? "retention-pending" : "progress",
    retainedCopies: phase === "live-erased" ? [{ id: "owner-backup", kind: "backup", expiresAt }] : [] };
}
function fixture(count = 1, installationId = "inst_old") {
  let now = 1000;
  const storage = new TestDurableObjectStorage();
  const durable = storage.asDurableStorage();
  runAdapterInstallationSqlMigrations(durable);
  const self: AdapterInstallationRetirementOptions["self"] = { kind: "adapter-installation", name: installationId, objectId: objectId(999), namespaceId: "b".repeat(32) };
  const quiesce = vi.fn<InstallationDeletionService["quiesceInstallation"]>(async (input) => receipt(input, "quiesced"));
  const erase = vi.fn<InstallationDeletionService["eraseInstallation"]>(async (input) => receipt(input, "live-erased", now + lifetime));
  const status = vi.fn<InstallationDeletionService["installationDeletionStatus"]>(async (input) => receipt(input, "erased"));
  const owner: InstallationDeletionService = { quiesceInstallation: quiesce, eraseInstallation: erase, installationDeletionStatus: status };
  const resolve = vi.fn<AdapterInstallationRetirementOptions["resolve"]>(() => owner);
  const options = { self, resolve, clock: () => now };
  let coordinator = new AdapterInstallationRetirement(durable, installationId, options);
  const resources = Array.from({ length: count }, (_, index) => resource(index + 1));
  const manifest = { installationId, discoverySha256: "f".repeat(64), resources: [self, ...resources] };
  const input: InstallationDeletionRequest = { version: 1, installationId, operationId: "delete-space" };
  return { storage, durable, self, resources, manifest, input, quiesce, erase, status, resolve,
    get coordinator() { return coordinator; },
    advance(ms: number) { now += ms; },
    restart() { runAdapterInstallationSqlMigrations(durable); coordinator = new AdapterInstallationRetirement(durable, installationId, options); },
    async seal() { for (let batch = 0; batch <= count / 16; batch++) if ((await coordinator.importInstallationDeletionInventory(manifest)).outcome === "verified") return; throw new Error("Import did not finish"); },
  };
}

describe("adapter installation deletion coordinator", () => {
  it("keeps status read-only and persists physical registrations across eviction and generation changes", async () => {
    const f = fixture();
    expect(await f.coordinator.installationDeletionStatus(f.input)).toMatchObject({ phase: "pending", outcome: "missing-inventory" });
    f.coordinator.registerResource({ ...f.resources[0], generation: "first" });
    f.restart();
    f.coordinator.registerResource({ ...f.resources[0], generation: "second" });
    expect(f.storage.rows("SELECT name, generation FROM adapter_installation_resources")).toEqual([{ name: "peer-1", generation: "second" }]);
    expect(f.coordinator.registeredResource("adapter-peer", f.resources[0].objectId)).toEqual(f.resources[0]);
    expect(f.coordinator.registeredResource("adapter-pairing", f.resources[0].objectId)).toBeNull();
    await f.seal();
    expect(() => f.coordinator.registerResource(resource(2))).toThrow("closed");
    expect(() => new AdapterInstallationRetirement(f.durable, "other", { self: f.self, resolve: f.resolve })).toThrow("immutable");
  });

  it("requires the exact coordinator and every previously registered resource before freezing a full manifest", async () => {
    const f = fixture();
    f.coordinator.registerResource(f.resources[0]);
    await expect(f.coordinator.importInstallationDeletionInventory({ ...f.manifest, resources: [f.self] })).rejects.toThrow("omits a registered");
    await expect(f.coordinator.importInstallationDeletionInventory({ ...f.manifest, resources: f.resources })).rejects.toThrow("exact coordinator");
    await expect(f.coordinator.importInstallationDeletionInventory({ ...f.manifest, resources: [f.self, { ...f.resources[0], name: "wrong" }] })).rejects.toThrow("omits a registered");
    await f.seal();
    await expect(f.coordinator.importInstallationDeletionInventory({ ...f.manifest, resources: [...f.manifest.resources, resource(2)] })).rejects.toThrow("immutable");
    await expect(f.coordinator.importInstallationDeletionInventory({ ...f.manifest, discoverySha256: "0".repeat(64) })).rejects.toThrow("immutable");
  });

  it("imports in bounded batches and resumes the same full manifest after eviction", async () => {
    const f = fixture(17);
    expect((await f.coordinator.importInstallationDeletionInventory(f.manifest)).outcome).toBe("missing-inventory");
    expect(f.storage.rows("SELECT import_cursor, inventory_complete FROM adapter_installation_retirement")).toEqual([{ import_cursor: 16, inventory_complete: 0 }]);
    expect((await f.coordinator.quiesceInstallation(f.input)).outcome).toBe("missing-inventory");
    expect(f.quiesce).not.toHaveBeenCalled();
    f.restart();
    expect((await f.coordinator.importInstallationDeletionInventory(f.manifest)).outcome).toBe("verified");
    expect((await f.coordinator.quiesceInstallation(f.input)).phase).toBe("quiescing");
    expect(f.quiesce).toHaveBeenCalledTimes(16);
    f.restart();
    expect((await f.coordinator.quiesceInstallation(f.input)).phase).toBe("quiesced");
    expect(f.quiesce).toHaveBeenCalledTimes(17);
    await expect(f.coordinator.eraseInstallation({ ...f.input, operationId: "other" })).rejects.toThrow("immutable");
  });

  it("does not acknowledge an unsupported owner, incomplete receipt, or another operation's receipt", async () => {
    const f = fixture();
    f.resolve.mockReturnValue(null);
    expect(() => f.coordinator.registerResource(f.resources[0])).toThrow("unsupported");
    expect((await f.coordinator.importInstallationDeletionInventory(f.manifest)).outcome).toBe("missing-inventory");
    const owner = { quiesceInstallation: f.quiesce, eraseInstallation: f.erase, installationDeletionStatus: f.status };
    f.resolve.mockReturnValue(owner);
    await f.seal();
    f.quiesce.mockResolvedValueOnce({ ...receipt(f.input, "quiesced"), outcome: "missing-inventory" });
    expect(await f.coordinator.quiesceInstallation(f.input)).toMatchObject({ phase: "quiescing", outcome: "missing-inventory", pendingResources: 1 });
    f.quiesce.mockResolvedValueOnce(receipt({ ...f.input, installationId: "inst_other" }, "quiesced"));
    await expect(f.coordinator.quiesceInstallation(f.input)).rejects.toThrow("another operation");
    expect((await f.coordinator.eraseInstallation(f.input)).phase).toBe("quiescing");
    expect(f.erase).not.toHaveBeenCalled();
    expect((await f.coordinator.quiesceInstallation(f.input)).phase).toBe("quiesced");
  });

  it("rotates retained child status batches and keeps its own backup lifetime before terminal erasure", async () => {
    const f = fixture(17);
    await f.seal();
    await f.coordinator.quiesceInstallation(f.input);
    await f.coordinator.quiesceInstallation(f.input);
    expect((await f.coordinator.eraseInstallation(f.input)).phase).toBe("erasing");
    expect(f.erase).toHaveBeenCalledTimes(16);
    const erased = await f.coordinator.eraseInstallation(f.input);
    expect(erased).toMatchObject({ phase: "live-erased", outcome: "retention-pending", pendingResources: 0, retainedCopies: [{ kind: "backup", expiresAt: 1000 + lifetime }] });
    f.status.mockImplementation(async (input) => receipt(input, "live-erased", 1000 + lifetime));
    f.resolve.mockClear();
    await f.coordinator.installationDeletionStatus(f.input);
    await f.coordinator.installationDeletionStatus(f.input);
    expect(f.resolve.mock.calls.map(([item]) => item.name)).toEqual(f.resources.map((item) => item.name));
    f.status.mockImplementation(async (input) => receipt(input, "erased"));
    await f.coordinator.installationDeletionStatus(f.input);
    expect(await f.coordinator.installationDeletionStatus(f.input)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    f.advance(lifetime - 1);
    expect((await f.coordinator.installationDeletionStatus(f.input)).phase).toBe("live-erased");
    f.advance(1);
    expect(await f.coordinator.installationDeletionStatus(f.input)).toMatchObject({ phase: "erased", outcome: "complete", retainedCopies: [] });
    f.restart();
    expect(f.storage.rows("SELECT * FROM adapter_installation_resources")).toEqual([]);
    expect(await f.coordinator.installationDeletionStatus(f.input)).toMatchObject({ phase: "erased" });
    expect(() => f.coordinator.registerResource(resource(1))).toThrow("closed");
    await expect(f.coordinator.importInstallationDeletionInventory(f.manifest)).rejects.toThrow("erased");
  });

  it("preserves unknown child retention and never treats another space's shared peer as deleted", async () => {
    const old = fixture();
    const other = fixture(1, "inst_other");
    other.coordinator.registerResource(other.resources[0]);
    await old.seal();
    await old.coordinator.quiesceInstallation(old.input);
    old.erase.mockResolvedValue({ ...receipt(old.input, "live-erased"), retainedCopies: [
      { id: "unknown", kind: "backup", expiresAt: null }, { id: "logs", kind: "logs", expiresAt: 2000 },
    ] });
    expect(await old.coordinator.eraseInstallation(old.input)).toMatchObject({ retainedCopies: [{ kind: "backup", expiresAt: null }, { kind: "logs", expiresAt: 2000 }] });
    old.restart(); other.restart();
    expect((await other.coordinator.installationDeletionStatus(other.input)).phase).toBe("pending");
    other.coordinator.registerResource(resource(2));
    expect(other.storage.rows("SELECT name FROM adapter_installation_resources")).toHaveLength(2);
    expect(other.quiesce).not.toHaveBeenCalled();
  });

  it("does not regress progress when a timed-out quiesce response arrives after another retry erased the child", async () => {
    const f = fixture();
    await f.seal();
    let release!: (value: InstallationDeletionReceipt) => void;
    f.quiesce.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const late = f.coordinator.quiesceInstallation(f.input);
    expect(f.quiesce).toHaveBeenCalledTimes(1);
    expect((await f.coordinator.quiesceInstallation(f.input)).phase).toBe("quiesced");
    expect((await f.coordinator.eraseInstallation(f.input)).phase).toBe("live-erased");
    release(receipt(f.input, "quiesced"));
    expect((await late).phase).toBe("live-erased");
    expect(f.storage.rows("SELECT state FROM adapter_installation_resources")).toEqual([{ state: "live-erased" }]);
  });
});
