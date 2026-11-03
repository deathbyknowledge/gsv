import { z } from "zod";

/** A page read stays for a week on this device; a page that answered with nothing to show is asked again after an hour. */
export const LINK_PREVIEW_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const LINK_PREVIEW_FAILURE_KEEP_MS = 60 * 60 * 1000;
export const MAX_LINK_PREVIEW_ENTRIES = 500;

const DATABASE = "gsv-link-previews";
const ENTRIES = "entries";

const entrySchema = z.object({
  key: z.string(),
  storedAt: z.number(),
  value: z.unknown().optional(),
  failed: z.literal(true).optional(),
});

export type LinkPreviewCacheEntry = z.infer<typeof entrySchema>;

/** Where entries live. Every call may reject; the cache then reads the page as if nothing were kept. */
export type LinkPreviewCacheStore = {
  get(key: string): Promise<LinkPreviewCacheEntry | undefined>;
  put(entry: LinkPreviewCacheEntry): Promise<void>;
  /** Drops entries stored before `before`, then the oldest until at most `keep` remain; each write runs it. */
  prune(before: number, keep: number): Promise<void>;
};

/** The page or image answered, and there is nothing to show; unlike a lost connection, this is worth remembering. */
export class LinkPreviewUnavailableError extends Error {}

/**
 * Keeps what this device read for each link, so reopening a conversation shows its cards without reading the pages
 * again. Entries are validated as they come back, so a stored shape this version does not recognise is read afresh.
 */
export class LinkPreviewCache {
  private generation = 0;

  constructor(
    private readonly openStore: () => Promise<LinkPreviewCacheStore | null>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads already under way keep their result to themselves, so none writes back into a store just cleared. */
  fence(): void {
    this.generation += 1;
  }

  async read<T>(key: string, schema: z.ZodType<T>, fetch: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const store = await this.openStore().catch(() => null);
    const keep = async (entry: LinkPreviewCacheEntry) => {
      if (!store || generation !== this.generation) return;
      await store.put(entry).catch(() => {});
      await store.prune(this.now() - LINK_PREVIEW_KEEP_MS, MAX_LINK_PREVIEW_ENTRIES).catch(() => {});
    };
    const entry = await store?.get(key).catch(() => undefined);
    if (entry) {
      const age = this.now() - entry.storedAt;
      if (entry.failed && age < LINK_PREVIEW_FAILURE_KEEP_MS) throw new LinkPreviewUnavailableError("Link preview was unavailable recently");
      const kept = !entry.failed && age < LINK_PREVIEW_KEEP_MS ? schema.safeParse(entry.value) : undefined;
      if (kept?.success) return kept.data;
    }
    let value: T;
    try {
      value = await fetch();
    } catch (error) {
      if (error instanceof LinkPreviewUnavailableError) await keep({ key, storedAt: this.now(), failed: true });
      throw error;
    }
    await keep({ key, storedAt: this.now(), value });
    return value;
  }
}

let opened: Promise<IDBDatabase> | null = null;

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore(ENTRIES, { keyPath: "key" }).createIndex("storedAt", "storedAt");
    };
    opening.onsuccess = () => {
      const db = opening.result;
      // Signing out, in this tab or another, deletes the database; this tab lets go so the deletion is not
      // blocked, and its reads under way do not write back what was cleared.
      db.onversionchange = () => { linkPreviewCache.fence(); db.close(); opened = null; };
      db.onclose = () => { opened = null; };
      resolve(db);
    };
    opening.onerror = () => { opened = null; reject(opening.error); };
    opening.onblocked = () => { opened = null; reject(new Error("Link preview cache is blocked")); };
  });
  return opened;
}

const browserStore: LinkPreviewCacheStore = {
  async get(key) {
    const db = await openDatabase();
    const kept = entrySchema.safeParse(await request(db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).get(key)));
    return kept.success ? kept.data : undefined;
  },
  async put(entry) {
    const db = await openDatabase();
    const transaction = db.transaction(ENTRIES, "readwrite");
    transaction.objectStore(ENTRIES).put(entry);
    await done(transaction);
  },
  async prune(before, keep) {
    const db = await openDatabase();
    const transaction = db.transaction(ENTRIES, "readwrite");
    const entries = transaction.objectStore(ENTRIES);
    const counting = entries.count();
    counting.onsuccess = () => {
      let remaining = counting.result;
      const cursor = entries.index("storedAt").openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        // An entry this version cannot read goes too.
        const kept = entrySchema.safeParse(current.value);
        if (kept.success && kept.data.storedAt >= before && remaining <= keep) return;
        current.delete();
        remaining -= 1;
        current.continue();
      };
    };
    await done(transaction);
  },
};

/** This device's cache, or none where the browser offers no IndexedDB. */
export const linkPreviewCache = new LinkPreviewCache(async () => (globalThis.indexedDB ? browserStore : null));

/** Forgets every link this device read, so the next person at this browser does not see what the last one was sent. */
export async function clearLinkPreviewCache(): Promise<void> {
  if (!globalThis.indexedDB) return;
  linkPreviewCache.fence();
  const db = await opened?.catch(() => null);
  db?.close();
  opened = null;
  await new Promise<void>((resolve) => {
    const deleting = indexedDB.deleteDatabase(DATABASE);
    deleting.onsuccess = deleting.onerror = deleting.onblocked = () => resolve();
  });
}
