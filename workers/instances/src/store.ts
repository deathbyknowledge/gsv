import type { BrowserHandoff, BrowserProfile, CloudInstance, InstanceSelector, InstanceUsage, SysInstanceStartArgs } from "@humansandmachines/gsv/protocol";
import type { InstanceActor } from "@humansandmachines/gsv/services/instances";
import { browserTemplate, type BrowserLimits } from "./config";

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
  return JSON.parse(row.record) as BrowserProfile;
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
        ? this.profiles(actor.ownerUid).map(profile).reverse().find(value => value.state === "active")
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
  profiles(ownerUid: number): ProfileRow[] { return this.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE owner_uid = ? ORDER BY rowid DESC", ownerUid).toArray(); }
  ownedProfile(actor: InstanceActor, id: string): ProfileRow | null { return this.profiles(actor.ownerUid).find(row => row.id === id) ?? null; }
  putProfile(value: BrowserProfile): void { this.sql.exec("UPDATE profiles SET record = ? WHERE id = ?", JSON.stringify(value), value.profileId); }
  createProfile(actor: InstanceActor, requestId: string, label: string, limits: BrowserLimits): BrowserProfile {
    return this.storage.transactionSync(() => {
      const existing = this.profiles(actor.ownerUid).find(row => row.request_id === requestId);
      if (existing) {
        if (profile(existing).label !== label) throw new Error("Profile requestId has already been used with another label");
        return profile(existing);
      }
      const count = this.sql.exec<ProfileRow>("SELECT * FROM profiles").toArray().filter(row => profile(row).state !== "deleted").length;
      if (!limits.enabled || count >= limits.savedProfiles) throw new Error("Saved browser profile limit reached");
      const value: BrowserProfile = { profileId: crypto.randomUUID(), ownerUid: actor.ownerUid, label, createdAt: Date.now(), revision: 1, state: "active", saveStatus: "empty" };
      this.sql.exec("INSERT INTO profiles (id, owner_uid, request_id, record, key) VALUES (?, ?, ?, ?, ?)", value.profileId, actor.ownerUid, requestId, JSON.stringify(value), crypto.getRandomValues(new Uint8Array(32)).buffer);
      return value;
    });
  }
  handoffs(id: string): BrowserHandoff[] {
    // SAFETY: Only putHandoff writes this column, using the admitted handoff contract.
    return this.sql.exec<{ record: string }>("SELECT record FROM handoffs WHERE instance_id = ? ORDER BY rowid DESC", id).toArray().map(row => JSON.parse(row.record) as BrowserHandoff);
  }
  putHandoff(value: BrowserHandoff): void { this.sql.exec("INSERT INTO handoffs (instance_id, request_id, record) VALUES (?, ?, ?) ON CONFLICT(instance_id, request_id) DO UPDATE SET record = excluded.record", value.instanceId, value.requestId, JSON.stringify(value)); }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This exception boundary normalizes arbitrary caught values for private inspection.
  diagnostic(id: string | null, error: unknown): string {
    const ref = crypto.randomUUID();
    // Private diagnostics are retained at the owning boundary, never printed to telemetry.
    const details: string[] = [];
    const seen = new Set<unknown>();
    for (let cause = error; cause !== undefined && !seen.has(cause); cause = cause instanceof Error ? cause.cause : undefined) {
      seen.add(cause);
      details.push(cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack ?? ""}` : String(cause));
    }
    this.sql.exec("INSERT INTO diagnostics (id, instance_id, occurred_at, detail) VALUES (?, ?, ?, ?)", ref, id, Date.now(), details.join("\nCaused by: "));
    return ref;
  }
}
