import {
  APP_PLACEMENT_VERIFICATION_KEY_OBJECT,
  importAppPlacementVerificationKey,
  parseSerializedAppPlacementVerificationKeyRecord,
  verifyAppPlacementCertificate,
  type AppPlacementTuple,
} from "./app-placement-certificate";

const VERIFICATION_KEY_MAX_AGE_MS = 5 * 60 * 1000;
const FAILED_VERIFICATION_REFRESH_INTERVAL_MS = 60 * 1000;

type CachedAppPlacementVerificationKey = {
  key: CryptoKey;
  loadedAt: number;
};

const verificationKeyCache = new WeakMap<
  object,
  Promise<CachedAppPlacementVerificationKey | null>
>();
const failedVerificationRefreshAt = new WeakMap<object, number>();

/**
 * Verify the Master-certified placement before resolving a caller-selected
 * user Durable Object name. The public key is read from the internal narrow
 * R2 record only on an isolate cache miss; the Master is never on this path.
 */
export async function verifyAppPlacementAtEdge(
  storage: R2Bucket,
  placement: AppPlacementTuple,
  certificate: string,
): Promise<boolean> {
  const cached = await appPlacementVerificationKey(storage, false);
  if (!cached) return false;
  if (await verifyAppPlacementCertificate(cached.key, placement, certificate)) {
    return true;
  }

  // A signing-key recovery publishes a new SPKI. Refresh once on failure so
  // new certificates recover immediately, while forged public traffic can
  // force at most one R2 reload per isolate per interval.
  const cacheKey = storage as object;
  const now = Date.now();
  if ((failedVerificationRefreshAt.get(cacheKey) ?? 0) > now) {
    return false;
  }
  failedVerificationRefreshAt.set(
    cacheKey,
    now + FAILED_VERIFICATION_REFRESH_INTERVAL_MS,
  );
  const refreshed = await appPlacementVerificationKey(storage, true);
  return refreshed
    ? verifyAppPlacementCertificate(refreshed.key, placement, certificate)
    : false;
}

async function appPlacementVerificationKey(
  storage: R2Bucket,
  forceRefresh: boolean,
): Promise<CachedAppPlacementVerificationKey | null> {
  const cacheKey = storage as object;
  const existing = verificationKeyCache.get(cacheKey);
  if (existing) {
    const cached = await existing;
    if (
      cached
      && !forceRefresh
      && Date.now() - cached.loadedAt < VERIFICATION_KEY_MAX_AGE_MS
    ) {
      return cached;
    }
    const current = verificationKeyCache.get(cacheKey);
    if (current !== existing) {
      return current ? await current : appPlacementVerificationKey(storage, forceRefresh);
    }
  }

  const pending = loadAppPlacementVerificationKey(storage);
  verificationKeyCache.set(cacheKey, pending);
  const key = await pending;
  if (!key && verificationKeyCache.get(cacheKey) === pending) {
    verificationKeyCache.delete(cacheKey);
  }
  return key;
}

async function loadAppPlacementVerificationKey(
  storage: R2Bucket,
): Promise<CachedAppPlacementVerificationKey | null> {
  try {
    const object = await storage.get(APP_PLACEMENT_VERIFICATION_KEY_OBJECT);
    if (!object || object.size > 512) return null;
    const record = parseSerializedAppPlacementVerificationKeyRecord(
      await object.text(),
    );
    return record
      ? {
          key: await importAppPlacementVerificationKey(record),
          loadedAt: Date.now(),
        }
      : null;
  } catch {
    return null;
  }
}
