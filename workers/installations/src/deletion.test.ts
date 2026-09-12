import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InstallationDeletionReceipt, InstallationDeletionRequest, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { InstallationDeletionCoordinator } from "./deletion";
import { AccountStore } from "./store";

const inventory = { sha256: "a".repeat(64), owners: ["accounts", "gateway", "inference"] };

class Owner implements InstallationDeletionService {
  phase: InstallationDeletionReceipt["phase"] = "pending";
  fail = false;
  retained = false;
  calls: string[] = [];
  quiesceInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    this.calls.push("quiesce");
    if (this.fail) return Promise.reject(new Error("unavailable"));
    this.phase = "quiesced";
    return Promise.resolve(this.receipt(input));
  }
  eraseInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    this.calls.push("erase");
    if (this.fail) return Promise.reject(new Error("unavailable"));
    this.phase = this.retained ? "live-erased" : "erased";
    return Promise.resolve(this.receipt(input));
  }
  installationDeletionStatus(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    this.calls.push("status");
    if (!this.retained) this.phase = "erased";
    return Promise.resolve(this.receipt(input));
  }
  receipt(input: InstallationDeletionRequest): InstallationDeletionReceipt {
    return { ...input, phase: this.phase, updatedAt: Date.now(), pendingResources: 0,
      outcome: this.phase === "erased" ? "complete" : this.retained ? "retention-pending" : "progress",
      retainedCopies: this.retained ? [{ id: "backup", kind: "backup", expiresAt: Date.now() + 60_000 }] : [] };
  }
}

async function fixture() {
  const id = crypto.randomUUID();
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const principal = await accounts.createPrincipal({ email: `${id}@example.com`, displayName: "owner", verified: true });
  const old = await accounts.reserveInstallation({ principalId: principal.id, operationId: `create-${id}`, handle: `s${id.slice(0, 8)}` });
  await env.INSTALLATIONS_DB.batch([
    env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(old.installationId),
    env.INSTALLATIONS_DB.prepare("UPDATE hostnames SET state = 'active' WHERE installation_id = ?").bind(old.installationId),
  ]);
  const replacement = await accounts.resetInstallation({ installationId: old.installationId, operationId: `reset-${id}`, confirmHandle: old.handle, participants: [] });
  const request: InstallationDeletionRequest = { version: 1, operationId: `delete-${id}`, installationId: old.installationId };
  const owners = { accounts: new Owner(), gateway: new Owner(), inference: new Owner() };
  return { request, owners, replacement, coordinator: new InstallationDeletionCoordinator(env.INSTALLATIONS_DB, owners) };
}

describe("installation deletion coordination", () => {
  it("quiesces every owner before erasure and retains Accounts until other live data is gone", async () => {
    const state = await fixture();
    await state.coordinator.begin(state.request, inventory);
    state.owners.inference.fail = true;
    expect((await state.coordinator.advance(state.request.operationId)).phase).toBe("quiescing");
    expect(state.owners.gateway.calls).toEqual(["quiesce"]);
    expect(state.owners.accounts.calls).toEqual(["quiesce"]);
    state.owners.inference.fail = false;
    const resumed = new InstallationDeletionCoordinator(env.INSTALLATIONS_DB, state.owners);
    expect((await resumed.advance(state.request.operationId)).phase).toBe("erasing");
    await resumed.advance(state.request.operationId);
    expect(state.owners.accounts.calls).toEqual(["quiesce"]);
    expect(state.owners.gateway.calls).toEqual(["quiesce", "erase"]);
    expect((await resumed.advance(state.request.operationId)).phase).toBe("erased");
    expect(state.owners.accounts.calls).toEqual(["quiesce", "erase"]);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT state FROM installations WHERE id = ?").bind(state.replacement.installationId).first())?.state).toBe("reserved");
    expect((await env.INSTALLATIONS_DB.prepare("SELECT data_deletion_state FROM installation_reset_operations WHERE previous_installation_id = ?").bind(state.request.installationId).first())?.data_deletion_state).toBe("complete");
    await resumed.advance(state.request.operationId);
    expect(state.owners.accounts.calls).toEqual(["quiesce", "erase"]);
  });

  it("reports retained copies separately and resumes until the owner confirms expiry", async () => {
    const state = await fixture();
    state.owners.inference.retained = true;
    await state.coordinator.begin(state.request, inventory);
    await state.coordinator.advance(state.request.operationId);
    await state.coordinator.advance(state.request.operationId);
    const retained = await state.coordinator.advance(state.request.operationId);
    expect(retained.phase).toBe("live-erased");
    expect(retained.owners.find((owner) => owner.id === "inference")?.receipt?.retainedCopies).toHaveLength(1);
    state.owners.inference.retained = false;
    expect((await state.coordinator.advance(state.request.operationId)).phase).toBe("erased");
    expect(state.owners.inference.calls).toEqual(["quiesce", "erase", "status", "status"]);
  });

  it("does not reinterpret a missing historical owner as completion", async () => {
    const state = await fixture();
    await state.coordinator.begin(state.request, { ...inventory, owners: [...inventory.owners, "retired-adapter"] });
    const progress = await state.coordinator.advance(state.request.operationId);
    expect(progress.phase).toBe("quiescing");
    expect(progress.owners.find((owner) => owner.id === "retired-adapter")).toMatchObject({ outcome: "missing-owner", receipt: null });
    await expect(state.coordinator.begin(state.request, inventory)).rejects.toThrow();
    expect((await state.coordinator.status(state.request.operationId)).owners).toHaveLength(4);
  });

  it("rejects a changed inventory without adding an owner or changing another operation", async () => {
    const state = await fixture();
    await state.coordinator.begin(state.request, inventory);
    await expect(state.coordinator.begin(state.request, { ...inventory, owners: [...inventory.owners, "injected"] })).rejects.toThrow();
    expect((await state.coordinator.status(state.request.operationId)).owners).toHaveLength(3);
    await expect(state.coordinator.begin({ ...state.request, installationId: state.replacement.installationId }, inventory)).rejects.toThrow();
    await expect(state.coordinator.begin({ ...state.request, operationId: "other-operation", installationId: state.replacement.installationId }, inventory)).rejects.toThrow();
  });

  it("rejects missing acknowledgments and receipts from a different space", async () => {
    const state = await fixture();
    state.owners.inference.quiesceInstallation = async (input) => ({ ...state.owners.inference.receipt(input), installationId: state.replacement.installationId, phase: "erased", outcome: "complete" });
    await state.coordinator.begin(state.request, inventory);
    const progress = await state.coordinator.advance(state.request.operationId);
    expect(progress.phase).toBe("quiescing");
    expect(progress.owners.find((owner) => owner.id === "inference")).toMatchObject({ outcome: "retry", receipt: null });
  });

  it("serializes concurrent advances and fences late replies after a timed-out lease", async () => {
    const state = await fixture();
    let finish: (() => void) | undefined;
    const response = new Promise<void>((resolve) => { finish = resolve; });
    state.owners.inference.quiesceInstallation = async (input) => { await response; return { ...state.owners.inference.receipt(input), phase: "quiesced" }; };
    const coordinator = new InstallationDeletionCoordinator(env.INSTALLATIONS_DB, state.owners, Date.now, 20);
    await coordinator.begin(state.request, inventory);
    await Promise.all([coordinator.advance(state.request.operationId), coordinator.advance(state.request.operationId)]);
    expect(state.owners.gateway.calls).toEqual(["quiesce"]);
    finish!();
    await response;
    expect((await coordinator.status(state.request.operationId)).owners.find((owner) => owner.id === "inference")).toMatchObject({ outcome: "retry", receipt: null });
  });
});
