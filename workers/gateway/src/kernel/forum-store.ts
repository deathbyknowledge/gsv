import { FORUM_ORIGIN, FORUM_TERMS_VERSION, type ForumPreferences } from "@humansandmachines/gsv/services/forum";

export type ForumMembership = {
  origin: string;
  state: "pending" | "joined" | "leaving" | "left";
  preferences: ForumPreferences;
  revision: number;
  consentAt: number;
  requestId: string;
  usage: { day: string; ids: Record<string, string> };
};

/** An owner's network choice is an opaque Kernel-owned record, outside editable config. */
export class ForumStore {
  constructor(private readonly storage: DurableObjectStorage) {}
  get(uid: number): ForumMembership | null { return this.storage.kv.get<ForumMembership>(`forum:v1:${uid}`) ?? null; }
  set(uid: number, record: ForumMembership): void { this.storage.kv.put(`forum:v1:${uid}`, record); }
  seed(uid: number, name: string, agentUid: number | null, origin = FORUM_ORIGIN): void {
    if (this.get(uid)) return;
    this.set(uid, { origin, state: "pending", revision: 1, consentAt: Date.now(), requestId: crypto.randomUUID(), usage: { day: "", ids: {} },
      preferences: { displayName: name, about: "", allowAgents: true, agentUids: agentUid === null ? [] : [agentUid], postsPerDay: 5, datasetConsent: false, termsVersion: FORUM_TERMS_VERSION } });
  }
}
