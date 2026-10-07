import type { BrowserHandoff, BrowserProfile, BrowserProfileSummary, CloudInstance, InstanceSelector, InstanceUsage, SysBrowserProfileListResult, SysInstanceStartArgs } from "@humansandmachines/gsv/protocol";
import type { InstanceActor } from "@humansandmachines/gsv/services/instances";
import { browserTemplate, type BrowserLimits } from "./config";
import { boundBrowserStorageUsage } from "./browser-storage-summary";

export type InstanceRow = {
  id: string; owner_uid: number; request_id: string; fingerprint: string; record: string; active: number;
  period_start: number; reservation: number; charged: number; session_id: string | null; acquire_at: number | null; runtime: string | null;
  provider_failed_at: number | null;
};
export type ProfileRow = { id: string; owner_uid: number; request_id: string; record: string; key: ArrayBuffer | null; object_key: string | null; saved_revision: number };
export function period(now: number) {
  const date = new Date(now);
  return { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
export function instance(row: InstanceRow): CloudInstance {
  // SAFETY: This private column is written only from admitted CloudInstance records and versioned migrations.
  const value = JSON.parse(row.record) as CloudInstance;
  if (value.label === "Cloud browser") value.label = `Browser ${value.instanceId.slice(0, 8)}`;
  return value;
}
export function profile(row: ProfileRow): BrowserProfile {
  // SAFETY: The profile owner serializes BrowserProfile records into this private column.
  const value = JSON.parse(row.record) as BrowserProfile;
  if (value.usage) value.usage = boundBrowserStorageUsage(value.usage);
  return value;
}
export class InstanceStore {
  constructor(readonly storage: DurableObjectStorage) {}
  get sql(): SqlStorage { return this.storage.sql; }
  rows(activeOnly = false): InstanceRow[] { return this.sql.exec<InstanceRow>(`SELECT * FROM instances ${activeOnly ? "WHERE active = 1" : ""} ORDER BY rowid DESC`).toArray(); }
  owned(actor: InstanceActor, selector: InstanceSelector): InstanceRow | null {
    return selector.instanceId
      ? this.sql.exec<InstanceRow>("SELECT * FROM instances WHERE owner_uid = ? AND (id = ? OR json_extract(record, '$.targetId') = ?)", actor.ownerUid, selector.instanceId, selector.instanceId).toArray()[0] ?? null
      : this.sql.exec<InstanceRow>("SELECT i.* FROM instances i JOIN start_requests r ON r.instance_id = i.id AND r.owner_uid = i.owner_uid WHERE r.owner_uid = ? AND r.request_id = ?", actor.ownerUid, selector.startRequestId!).toArray()[0] ?? null;
  }
  byId(id: string): InstanceRow {
    const row = this.sql.exec<InstanceRow>("SELECT * FROM instances WHERE id = ?", id).toArray()[0];
    if (!row) throw new Error("Instance does not exist");
    return row;
  }
  usage(limits: BrowserLimits, now = Date.now()): InstanceUsage {
    const { start, end } = period(now);
    const rows = this.rows();
    return {
      periodStartsAt: start, periodEndsAt: end, limitSeconds: limits.periodSeconds, concurrentLimit: limits.concurrentInstances,
      activeInstances: rows.filter(row => row.active).length,
      usedSeconds: rows.filter(row => row.period_start === start).reduce((sum, row) => sum + row.charged, 0),
      reservedSeconds: rows.filter(row => row.active).reduce((sum, row) => sum + row.reservation, 0),
    };
  }
  admit(actor: InstanceActor, args: SysInstanceStartArgs, limits: BrowserLimits, now = Date.now(), stopping?: ReadonlySet<string>): CloudInstance {
    return this.storage.transactionSync(() => {
      const fingerprint = JSON.stringify([args.templateId, args.label ?? null, args.lifetimeSeconds ?? null, args.profileId ?? null, args.fresh ?? false]);
      const existing = this.sql.exec<{ instance_id: string; fingerprint: string }>("SELECT instance_id, fingerprint FROM start_requests WHERE owner_uid = ? AND request_id = ?", actor.ownerUid, args.requestId).toArray()[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("Start requestId has already been used with different arguments");
        return instance(this.byId(existing.instance_id));
      }
      if (this.sql.exec("SELECT 1 FROM cancelled_starts WHERE owner_uid = ? AND request_id = ?", actor.ownerUid, args.requestId).toArray().length) throw new Error("This start request was cancelled before admission; use a fresh requestId for new work");
      if (args.templateId !== "browser" || !limits.enabled) throw new Error("Browser instances are not enabled");
      const lifetime = args.lifetimeSeconds ?? browserTemplate(limits).defaultLifetimeSeconds;
      if (lifetime < 60 || lifetime > limits.maxInstanceSeconds) throw new Error("Requested browser lifetime is outside the allowed range");
      if (!args.fresh) {
        const current = this.rows(true).map(instance).reverse().find(value => value.ownerUid === actor.ownerUid
          && (value.state === "ready" || value.state === "starting") && value.expiresAt > now
          && !value.isolated
          && (!args.profileId || value.profileId === args.profileId));
        if (current) {
          if (stopping?.has(current.instanceId)) throw new Error("Browser is preparing to stop; retry starting after it settles");
          this.sql.exec("INSERT INTO start_requests VALUES (?, ?, ?, ?)", actor.ownerUid, args.requestId, current.instanceId, fingerprint);
          return current;
        }
      }
      const usage = this.usage(limits, now);
      if (usage.activeInstances >= limits.concurrentInstances) throw new Error("Browser concurrency limit reached");
      if (usage.usedSeconds + usage.reservedSeconds + lifetime > limits.periodSeconds) throw new Error("Browser time allowance exhausted");
      const defaultProfile = !args.profileId && !args.fresh
        ? this.defaultProfile(actor.ownerUid)
          ?? this.createProfile(actor, crypto.randomUUID(), "Browser", limits)
        : null;
      const profileId = args.profileId ?? defaultProfile?.profileId;
      const saved = profileId ? this.ownedProfile(actor, profileId) : null;
      if (args.profileId && (!saved || profile(saved).state !== "active")) throw new Error("Saved browser profile is unavailable");
      if (saved && profile(saved).activeInstanceId) throw new Error(`Profile is already in use by ${profile(saved).activeInstanceId}`);
      let id = crypto.randomUUID();
      while (this.sql.exec("SELECT 1 FROM instances WHERE json_extract(record, '$.targetId') = ?", id.slice(0, 8)).toArray().length) id = crypto.randomUUID();
      const value: CloudInstance = {
        instanceId: id, targetId: id.slice(0, 8), startRequestId: args.requestId,
        ownerUid: actor.ownerUid, templateId: "browser", templateRevision: "1", kind: "browser", implements: browserTemplate(limits).implements,
        label: args.label ?? `Browser ${id.slice(0, 8)}`, state: "starting", revision: 1, profileId, isolated: args.fresh === true && !profileId,
        createdAt: now, expiresAt: now + lifetime * 1000,
      };
      this.sql.exec("INSERT INTO instances (id, owner_uid, request_id, fingerprint, record, active, period_start, reservation) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", id, actor.ownerUid, args.requestId, fingerprint, JSON.stringify(value), period(now).start, lifetime);
      this.sql.exec("INSERT INTO start_requests VALUES (?, ?, ?, ?)", actor.ownerUid, args.requestId, id, fingerprint);
      if (saved) this.putProfile({ ...profile(saved), activeInstanceId: id, revision: profile(saved).revision + 1 });
      return value;
    });
  }
  cancelStart(actor: InstanceActor, requestId: string): void {
    this.sql.exec("INSERT OR IGNORE INTO cancelled_starts (owner_uid, request_id) VALUES (?, ?)", actor.ownerUid, requestId);
  }
  update(value: CloudInstance): void { this.sql.exec("UPDATE instances SET record = ? WHERE id = ?", JSON.stringify(value), value.instanceId); }
  terminal(id: string, failed: boolean, now = Date.now()): CloudInstance {
    return this.storage.transactionSync(() => {
      const row = this.byId(id), previous = instance(row);
      if (!row.active) return previous;
      const value: CloudInstance = { ...previous, state: failed ? "failed" : "stopped", stoppedAt: now, revision: previous.revision + 1 };
      // A resource with an unknown allocation is conservatively charged its reservation.
      const charge = previous.readyAt ? Math.min(row.reservation, Math.max(0, Math.ceil((now - previous.readyAt) / 1000))) : row.acquire_at && !row.session_id ? row.reservation : 0;
      this.sql.exec("UPDATE instances SET record = ?, active = 0, reservation = 0, charged = ? WHERE id = ?", JSON.stringify(value), charge, id);
      if (value.profileId) {
        const saved = this.ownedProfile({ ownerUid: value.ownerUid, human: false }, value.profileId);
        if (saved && profile(saved).activeInstanceId === id) this.putProfile({ ...profile(saved), activeInstanceId: undefined, revision: profile(saved).revision + 1 });
      }
      this.sql.exec("DELETE FROM files WHERE instance_id = ?", id);
      this.sql.exec("DELETE FROM file_chunks WHERE instance_id = ?", id);
      return value;
    });
  }
  profiles(ownerUid: number): Iterable<ProfileRow> { return this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE owner_uid = ? ORDER BY rowid DESC", ownerUid); }
  listProfiles(ownerUid: number, offset = 0): SysBrowserProfileListResult {
    const total = this.sql.exec<{ count: number }>("SELECT count(*) AS count FROM profiles WHERE owner_uid = ? AND json_extract(record, '$.state') != 'deleted'", ownerUid).one().count;
    const profiles = this.sql.exec<{ record: string }>("SELECT json_remove(record, '$.usage', '$.issues') AS record FROM profiles WHERE owner_uid = ? AND json_extract(record, '$.state') != 'deleted' ORDER BY rowid LIMIT 32 OFFSET ?", ownerUid, offset).toArray().map(row => {
      // SAFETY: SQL removes the detailed fields from the privately stored BrowserProfile record.
      return JSON.parse(row.record) as BrowserProfileSummary;
    });
    return { profiles, total, nextOffset: offset + profiles.length < total ? offset + profiles.length : undefined };
  }
  private defaultProfile(ownerUid: number): BrowserProfile | null {
    const row = this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE owner_uid = ? AND json_extract(record, '$.state') = 'active' ORDER BY rowid LIMIT 1", ownerUid).toArray()[0];
    return row ? profile(row) : null;
  }
  ownedProfile(actor: InstanceActor, id: string): ProfileRow | null { return this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE owner_uid = ? AND id = ?", actor.ownerUid, id).toArray()[0] ?? null; }
  putProfile(value: BrowserProfile): void {
    const bounded = value.usage ? { ...value, usage: boundBrowserStorageUsage(value.usage) } : value;
    this.sql.exec("UPDATE profiles SET record = ? WHERE id = ?", JSON.stringify(bounded), value.profileId);
  }
  createProfile(actor: InstanceActor, requestId: string, label: string, limits: BrowserLimits): BrowserProfile {
    return this.storage.transactionSync(() => {
      const existing = this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE owner_uid = ? AND request_id = ?", actor.ownerUid, requestId).toArray()[0];
      if (existing) {
        if (profile(existing).label !== label) throw new Error("Profile requestId has already been used with another label");
        return profile(existing);
      }
      const count = this.sql.exec<{ count: number }>("SELECT count(*) AS count FROM profiles WHERE json_extract(record, '$.state') != 'deleted'").one().count;
      if (!limits.enabled || count >= limits.savedProfiles) throw new Error("Saved browser profile limit reached");
      const value: BrowserProfile = { profileId: crypto.randomUUID(), ownerUid: actor.ownerUid, label, createdAt: Date.now(), revision: 1, state: "active", saveStatus: "empty" };
      this.sql.exec("INSERT INTO profiles (id, owner_uid, request_id, record, key) VALUES (?, ?, ?, ?, ?)", value.profileId, actor.ownerUid, requestId, JSON.stringify(value), crypto.getRandomValues(new Uint8Array(32)).buffer);
      return value;
    });
  }
  liveHandoffs(id: string): BrowserHandoff[] {
    // SAFETY: Only putHandoff writes this column, using the admitted handoff contract.
    return this.sql.exec<{ record: string }>("SELECT record FROM handoffs WHERE instance_id = ? AND json_extract(record, '$.state') IN ('pending', 'active') ORDER BY rowid DESC", id).toArray().map(row => JSON.parse(row.record) as BrowserHandoff);
  }
  handoff(id: string, requestId: string): BrowserHandoff | undefined {
    const row = this.sql.exec<{ record: string }>(`SELECT record FROM handoffs WHERE instance_id = ? AND request_id = ?
      UNION ALL SELECT record FROM handoff_receipts WHERE instance_id = ? AND request_id = ? LIMIT 1`, id, requestId, id, requestId).toArray()[0];
    // SAFETY: Both tables contain admitted handoffs; receipts omit only optional expired details.
    return row ? JSON.parse(row.record) as BrowserHandoff : undefined;
  }
  putHandoff(value: BrowserHandoff): void {
    this.storage.transactionSync(() => {
      if (value.state !== "pending" && value.state !== "active") value = { ...value, completedAt: value.completedAt ?? Date.now() };
      this.sql.exec("INSERT INTO handoffs (instance_id, request_id, record) VALUES (?, ?, ?) ON CONFLICT(instance_id, request_id) DO UPDATE SET record = excluded.record", value.instanceId, value.requestId, JSON.stringify(value));
      this.sql.exec(`INSERT OR IGNORE INTO handoff_receipts SELECT instance_id, request_id,
        json_remove(record, '$.diagnosticRef', '$.reason', '$.activeTabId') FROM handoffs
        WHERE json_extract(record, '$.state') NOT IN ('pending', 'active') AND rowid NOT IN (
          SELECT rowid FROM handoffs WHERE json_extract(record, '$.state') NOT IN ('pending', 'active')
          ORDER BY COALESCE(json_extract(record, '$.completedAt'), json_extract(record, '$.createdAt')) DESC, rowid DESC LIMIT 64
        )`);
      this.sql.exec("DELETE FROM handoffs WHERE EXISTS (SELECT 1 FROM handoff_receipts r WHERE r.instance_id = handoffs.instance_id AND r.request_id = handoffs.request_id)");
    });
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This exception boundary normalizes arbitrary caught values for private inspection.
  diagnostic(id: string | null, error: unknown): string {
    // Private diagnostics are retained at the owning boundary, never printed to telemetry.
    const details: string[] = [];
    const seen = new Set<unknown>();
    let cause = error;
    for (; cause !== undefined && !seen.has(cause) && details.length < 8; cause = cause instanceof Error ? cause.cause : undefined) {
      seen.add(cause);
      details.push(cause instanceof Error ? `${cause.name.slice(0, 4096)}: ${cause.message.slice(0, 4096)}\n${cause.stack?.slice(0, 4096) ?? ""}` : String(cause).slice(0, 4096));
    }
    const full = details.join("\nCaused by: ");
    const detail = full.length > 4080 || cause !== undefined ? `${full.slice(0, 4080)}\n[truncated]` : full;
    const existing = this.sql.exec<{ id: string }>("SELECT id FROM diagnostics WHERE instance_id IS ? AND detail = ? ORDER BY occurred_at DESC LIMIT 1", id, detail).toArray()[0];
    if (existing) {
      this.sql.exec("UPDATE diagnostics SET occurred_at = ? WHERE id = ?", Date.now(), existing.id);
      return existing.id;
    }
    const ref = crypto.randomUUID();
    this.sql.exec("INSERT INTO diagnostics (id, instance_id, occurred_at, detail) VALUES (?, ?, ?, ?)", ref, id, Date.now(), detail);
    return ref;
  }
  pruneDiagnostics(savingInstances: string[] = []): void {
    // In-flight saves may have created site diagnostics whose profile commit is still pending.
    this.sql.exec(`WITH records(record) AS (
      SELECT json_object('diagnosticRef', json_extract(record, '$.diagnosticRef'), 'persistence', json_extract(record, '$.persistence')) FROM instances
      UNION ALL SELECT json_remove(record, '$.usage') FROM profiles WHERE json_extract(record, '$.state') != 'deleted'
      UNION ALL SELECT record FROM handoffs
    ), referenced(ref) AS (
      SELECT item.atom FROM records, json_tree(records.record) item WHERE item.key = 'diagnosticRef' AND item.type = 'text'
      UNION SELECT id FROM diagnostics WHERE instance_id IN (SELECT value FROM json_each(?))
    ), retained(id) AS (SELECT ref FROM referenced WHERE ref IS NOT NULL), recent(id) AS (
      SELECT id FROM diagnostics WHERE id NOT IN (SELECT id FROM retained) ORDER BY occurred_at DESC, rowid DESC LIMIT 64
    ) DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM retained) AND id NOT IN (SELECT id FROM recent)`, JSON.stringify(savingInstances));
  }
}
