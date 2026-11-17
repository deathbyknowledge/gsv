import type { CloudInstance, ComputerWorkspace } from "@humansandmachines/gsv/protocol";
import type { WorkspaceAddress, WorkspaceSave } from "./computer-workspace";
import { instance, type InstanceStore } from "./store";

/** A saved /workspace is kept this long after its computer expired. */
export const WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type WorkspaceRow = { instance_id: string; owner_uid: number; object_key: string; key: ArrayBuffer; expires_at: number | null };

/**
 * Each computer owns one key for its saved /workspace. The archive lives in
 * the installation's profile bucket until its retention ends; deleting the row
 * forgets the key, and the sweep deletes the object first.
 */
export class ComputerWorkspaces {
  constructor(private readonly installationId: string, private readonly bucket: R2Bucket, private readonly store: InstanceStore) {}

  /** Idempotent for a replayed start of the same computer. */
  create(value: CloudInstance): void {
    this.store.sql.exec("INSERT OR IGNORE INTO workspaces (instance_id, owner_uid, object_key, key) VALUES (?, ?, ?, ?)",
      value.instanceId, value.ownerUid, `${this.installationId}/owners/${value.ownerUid}/workspaces/${value.instanceId}`, crypto.getRandomValues(new Uint8Array(32)).buffer);
  }

  address(id: string): WorkspaceAddress | undefined {
    const row = this.store.sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE instance_id = ?", id).toArray()[0];
    if (!row) return undefined;
    if (!row.object_key.startsWith(`${this.installationId}/owners/${row.owner_uid}/workspaces/`)) throw new Error("Saved workspace scope mismatch");
    return { objectKey: row.object_key, key: row.key };
  }

  saving(id: string): void {
    const value = instance(this.store.byId(id));
    if (value.workspace?.saveStatus !== "saving") this.store.update({ ...value, workspace: { saveStatus: "saving" }, revision: value.revision + 1 });
  }

  /** Records how a stopped computer's save ended. An archive that is not kept is deleted by the next sweep. */
  settle(id: string, result: WorkspaceSave | undefined, now = Date.now()): void {
    const value = instance(this.store.byId(id));
    const kept = result && "savedAt" in result;
    this.store.sql.exec("UPDATE workspaces SET expires_at = ? WHERE instance_id = ?", kept ? result.savedAt + WORKSPACE_RETENTION_MS : now, id);
    let workspace: ComputerWorkspace | undefined;
    if (kept) workspace = { saveStatus: "saved", savedAt: result.savedAt, bytes: result.bytes, expiresAt: result.savedAt + WORKSPACE_RETENTION_MS };
    else if (result) workspace = { saveStatus: "failed", error: "The workspace could not be saved", diagnosticRef: this.store.diagnostic(id, new Error(result.error)) };
    if (workspace || value.workspace) this.store.update({ ...value, workspace, revision: value.revision + 1 });
  }

  /** Deletes archives whose retention ended and returns when the next one ends. */
  async sweep(now = Date.now()): Promise<number | null> {
    const due = this.store.sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE expires_at <= ? ORDER BY expires_at LIMIT 100", now).toArray();
    if (due.length) await this.bucket.delete(due.map(row => row.object_key));
    for (const row of due) {
      this.store.sql.exec("DELETE FROM workspaces WHERE instance_id = ?", row.instance_id);
      const value = instance(this.store.byId(row.instance_id));
      if (value.workspace?.saveStatus === "saved") this.store.update({ ...value, workspace: { ...value.workspace, saveStatus: "deleted" }, revision: value.revision + 1 });
    }
    return this.store.sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM workspaces").one().next;
  }
}
