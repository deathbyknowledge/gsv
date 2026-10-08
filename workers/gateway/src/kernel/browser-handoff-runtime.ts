import type { BrowserHandoff } from "@humansandmachines/gsv/protocol";
import { raceWithAbort } from "../shared/abort";
import { acquireInstances } from "./instance-service";
import type { Kernel } from "./do";

const RECHECK_MS = 5000;
type HandoffLink = {
  owner_uid: number; instance_id: string; request_id: string; responsibility_id: string;
  retry_at: number; attempts: number;
};

/** Owns recovery independently of the caller and editable responsibility details. */
export class BrowserHandoffRuntime {
  constructor(private readonly host: Kernel) {}

  async track(ownerUid: number, handoff: BrowserHandoff): Promise<void> {
    if (!handoff.responsibilityId || (handoff.state !== "pending" && handoff.state !== "active")) return;
    this.host.ctx.storage.transactionSync(() => {
      const inserted = this.host.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO browser_handoff_links (owner_uid, instance_id, request_id, responsibility_id) VALUES (?, ?, ?, ?)",
        ownerUid, handoff.instanceId, handoff.requestId, handoff.responsibilityId!,
      );
      // A new link must not reuse an empty task that is just finishing.
      if (inserted.rowsWritten) this.host.tasks.enqueue(new Date(Date.now() + RECHECK_MS), { callback: "onBrowserHandoffs", payload: null });
    });
    await this.host.tasks.arm();
  }

  async recover(): Promise<void> {
    if (this.hasLinks()) await this.host.schedule(new Date(Date.now() + RECHECK_MS), "onBrowserHandoffs", null, { idempotent: true });
  }

  async run(runningTaskId: string): Promise<void> {
    if (!this.hasLinks()) return;
    // Persist a successor before remote I/O; eviction or failure cannot lose cleanup.
    await this.host.schedule(new Date(Date.now() + RECHECK_MS), "onBrowserHandoffs", null, { idempotent: true, excludeTaskId: runningTaskId });
    const links = this.host.ctx.storage.sql.exec<HandoffLink>("SELECT * FROM browser_handoff_links WHERE retry_at <= ?", Date.now()).toArray();
    await Promise.all(links.map(link => this.reconcile(link)));
  }

  private hasLinks(): boolean {
    return this.host.ctx.storage.sql.exec("SELECT 1 FROM browser_handoff_links LIMIT 1").toArray().length > 0;
  }

  private async reconcile(link: HandoffLink): Promise<void> {
    const sql = this.host.ctx.storage.sql;
    const key = [link.owner_uid, link.instance_id, link.request_id] as const;
    const signal = AbortSignal.timeout(5000);
    try {
      const service = await acquireInstances(this.host.buildKernelContext({ callerOwnerUid: link.owner_uid }), signal);
      try {
        const actor = { ownerUid: link.owner_uid, human: false };
        const selector = { instanceId: link.instance_id, requestId: link.request_id };
        let { handoff } = await raceWithAbort(service.getHandoff(actor, selector), signal);
        if (!handoff || handoff.responsibilityId === link.responsibility_id) {
          let work = this.host.responsibilities.get(link.owner_uid, link.responsibility_id);
          if (!work || work.state === "resolved" || work.state === "cancelled") {
            if (handoff?.state === "pending" || handoff?.state === "active") {
              ({ handoff } = await raceWithAbort(service.cancelHandoff(actor, selector), signal));
            }
          }
          if (handoff?.state === "pending" || handoff?.state === "active") {
            sql.exec("UPDATE browser_handoff_links SET attempts = 0, retry_at = 0, diagnostic_ref = NULL, last_error = NULL WHERE owner_uid = ? AND instance_id = ? AND request_id = ?", ...key);
            return;
          }
          // Re-read after provider I/O: a terminal or newly edited task must not be reopened.
          work = this.host.responsibilities.get(link.owner_uid, link.responsibility_id);
          if (work?.state === "waiting" && work.blocker === `browser handoff ${link.instance_id}/${link.request_id}`) {
            this.host.responsibilities.update({ ownerUid: link.owner_uid, id: work.id, expectedRevision: work.revision,
              patch: { state: "open", blocker: null, nextCheckAtMs: Date.now() },
              actor: { kind: "system", component: "browser-handoff" }, observedByShip: false, now: Date.now() });
          }
          await this.host.responsibilityRuntime.reconcileResponsibilityWake(link.owner_uid);
        }
        sql.exec("DELETE FROM browser_handoff_links WHERE owner_uid = ? AND instance_id = ? AND request_id = ?", ...key);
      } finally { service[Symbol.dispose]?.(); }
    } catch (error) {
      const ref = crypto.randomUUID();
      sql.exec("UPDATE browser_handoff_links SET attempts = attempts + 1, retry_at = ?, diagnostic_ref = ?, last_error = ? WHERE owner_uid = ? AND instance_id = ? AND request_id = ?",
        Date.now() + Math.min(60000, RECHECK_MS * 2 ** Math.min(link.attempts, 4)), ref,
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error), ...key);
      console.warn(`[browser-handoff] reconciliation failed; diagnostic ${ref}`);
    }
  }
}
