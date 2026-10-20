import { z } from "zod";
import type { WelcomeSnapshot, WelcomeState, WelcomeStorage } from "../app/services/session/ownerWelcome";
import { t } from "../app/i18n/locale";

const snapshotSchema = z.object({
  revision: z.string().min(1),
  value: z.object({
    origin: z.string(), flow: z.enum(["open", "create"]), sessionSecret: z.string().nullable(),
    challenge: z.object({ id: z.string(), email: z.string(), browserSecret: z.string() }).nullable(),
    operationId: z.string().nullable().default(null), handle: z.string().nullable(),
    contactInvite: z.string().nullable().optional(),
  }).nullable(),
});

/** A read/write transaction fences another tab before any owner request starts. */
export class BrowserWelcomeStorage implements WelcomeStorage {
  constructor(private readonly origin: string) {}

  load(): Promise<WelcomeSnapshot> { return this.transact(); }

  save(revision: string, value: WelcomeState | null): Promise<WelcomeSnapshot> {
    return this.transact({ revision, value });
  }

  private transact(change?: { revision: string; value: WelcomeState | null }): Promise<WelcomeSnapshot> {
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open("gsv-owner-welcome", 1);
      let blocked = false;
      opening.onupgradeneeded = () => { opening.result.createObjectStore("flow"); };
      opening.onerror = () => reject(new Error(t("signup.storage.saveFailed")));
      opening.onblocked = () => { blocked = true; reject(new Error(t("signup.storage.blocked"))); };
      opening.onsuccess = () => {
        const db = opening.result;
        if (blocked) { db.close(); return; }
        const transaction = db.transaction("flow", change ? "readwrite" : "readonly");
        const records = transaction.objectStore("flow");
        const read = records.get("current");
        let result: WelcomeSnapshot;
        let failure: Error | undefined;
        transaction.oncomplete = () => { db.close(); resolve(result); };
        transaction.onabort = transaction.onerror = () => {
          db.close(); reject(failure ?? new Error(t("signup.storage.saveFailed")));
        };
        read.onsuccess = () => {
          try {
            result = read.result === undefined ? { revision: "initial", value: null } : snapshotSchema.parse(read.result);
            if ((result.value && result.value.origin !== this.origin) || (change?.value && change.value.origin !== this.origin)) {
              throw new Error(t("signup.storage.otherOrigin"));
            }
            if (!change) return;
            if (result.revision !== change.revision) throw new Error(t("signup.storage.changed"));
            result = { revision: crypto.randomUUID(), value: change.value };
            records.put(result, "current");
          } catch (error) {
            failure = error instanceof Error ? error : new Error(t("signup.storage.readFailed"));
            transaction.abort();
          }
        };
      };
    });
  }
}
