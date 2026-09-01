import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from "@whiskeysockets/baileys";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { z } from "zod";

const CREDS_KEY = "auth:creds";
const AUTH_EPOCH_KEY = "auth:epoch";
const SIGNAL_PREFIX = "signal:";
const STORAGE_BATCH_SIZE = 128;

type AuthValue = AuthenticationCreds | AuthValueObject | Uint8Array | AuthValue[] | string | number | boolean | null | undefined;
interface AuthValueObject extends Partial<Record<keyof AuthenticationCreds, AuthValue>> {
  type?: string;
  data?: number[];
  id?: string;
  name?: string;
  deviceId?: number;
  identifier?: AuthValueObject;
  identifierKey?: Uint8Array;
  unarchiveChats?: boolean;
  defaultDisappearingMode?: AuthValueObject;
  public?: Uint8Array;
  private?: Uint8Array;
  keyPair?: AuthValueObject;
  signature?: Uint8Array;
  keyId?: number;
  timestampS?: number;
}
const authObjectSchema = z.record(z.string(), z.unknown());
const bufferEnvelopeSchema = z.object({
  type: z.literal("Buffer"),
  data: z.array(z.number()),
});

class StaleWhatsAppAuthStateError extends Error {
  constructor() {
    super("WhatsApp authentication state is stale");
    this.name = "StaleWhatsAppAuthStateError";
  }
}

const serializeAuthValue = (value: AuthValue): string =>
  JSON.stringify(value, BufferJSON.replacer);

const deserializeAuthValue = (value: string): AuthValue =>
  JSON.parse(value, authValueReviver);

function authValueReviver(key: string, value: AuthValue): AuthValue {
  const revived = BufferJSON.reviver(key, value);
  if (revived !== value) return revived;

  const bufferEnvelope = bufferEnvelopeSchema.safeParse(value);
  if (bufferEnvelope.success) return Buffer.from(bufferEnvelope.data.data);

  return value;
}

function chunk<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += STORAGE_BATCH_SIZE) {
    chunks.push(items.slice(index, index + STORAGE_BATCH_SIZE));
  }
  return chunks;
}

async function assertAuthEpoch(
  storage: DurableObjectTransaction,
  authEpoch: number,
): Promise<void> {
  const currentEpoch = normalizeAuthEpoch(
    await storage.get<number>(AUTH_EPOCH_KEY),
  );
  if (currentEpoch !== authEpoch) {
    throw new StaleWhatsAppAuthStateError();
  }
}

function deserializeSignalValue<T extends keyof SignalDataTypeMap>(
  type: T,
  stored: string,
): SignalDataTypeMap[T] {
  const value = deserializeAuthValue(stored);
  if (type === "app-state-sync-key") {
    if (!isRecord(value)) throw new TypeError("Invalid app state sync key");
    // SAFETY: the signal key discriminator selects the matching Baileys protobuf value.
    const appStateValue = proto.Message.AppStateSyncKeyData.fromObject(value) as SignalDataTypeMap["app-state-sync-key"];
    // SAFETY: the signal key discriminator selects the matching Baileys protobuf value.
    return appStateValue as SignalDataTypeMap[T];
  }
  // SAFETY: Baileys supplies the value for the requested signal key type.
  return value as SignalDataTypeMap[T];
}

function createDOSignalKeyStore(
  storage: DurableObjectStorage,
  authEpoch: number,
): SignalKeyStore {
  return {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      const idChunks = chunk(ids);
      const values = await storage.transaction(async (txn) => {
        await assertAuthEpoch(txn, authEpoch);
        const entries = new Map<string, string>();
        for (const idChunk of idChunks) {
          const storageKeys = idChunk.map((id) => `${SIGNAL_PREFIX}${type}:${id}`);
          for (const [key, value] of await txn.get<string>(storageKeys)) {
            entries.set(key, value);
          }
        }
        return entries;
      });

      for (const idChunk of idChunks) {
        const storageKeys = idChunk.map((id) => `${SIGNAL_PREFIX}${type}:${id}`);
        for (const [index, id] of idChunk.entries()) {
          const stored = values.get(storageKeys[index]);
          if (stored === undefined) continue;
          try {
            result[id] = deserializeSignalValue(type, stored);
          } catch {
            // Corrupt individual Signal records are ignored so Baileys can
            // request fresh session material without discarding the account.
          }
        }
      }
      return result;
    },

    async set(data: SignalDataSet): Promise<void> {
      const puts: Array<[string, string]> = [];
      const deletes: string[] = [];
      for (const [type, entries] of Object.entries(data)) {
        if (!entries) continue;
        for (const [id, value] of Object.entries(entries)) {
          const key = `${SIGNAL_PREFIX}${type}:${id}`;
          if (value === null || value === undefined) {
            deletes.push(key);
          } else {
            puts.push([key, serializeAuthValue(value)]);
          }
        }
      }

      await storage.transaction(async (txn) => {
        await assertAuthEpoch(txn, authEpoch);
        for (const putChunk of chunk(puts)) {
          await txn.put(Object.fromEntries(putChunk));
        }
        for (const deleteChunk of chunk(deletes)) {
          await txn.delete(deleteChunk);
        }
      });
    },

    async clear(): Promise<void> {
      await storage.transaction(async (txn) => {
        await assertAuthEpoch(txn, authEpoch);
        const entries = await txn.list({ prefix: SIGNAL_PREFIX });
        for (const keyChunk of chunk([...entries.keys()])) {
          await txn.delete(keyChunk);
        }
      });
    },
  };
}

export async function useDOAuthState(
  storage: DurableObjectStorage,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  authReset: boolean;
}> {
  let creds: AuthenticationCreds;
  let authReset = false;
  const storedAuth = await storage.transaction(async (txn) => ({
    authEpoch: normalizeAuthEpoch(await txn.get<number>(AUTH_EPOCH_KEY)),
    storedCreds: await txn.get<string>(CREDS_KEY),
  }));
  let { authEpoch } = storedAuth;
  const { storedCreds } = storedAuth;

  if (storedCreds !== undefined) {
    try {
      const parsed = deserializeAuthValue(storedCreds);
      if (!isAuthenticationCreds(parsed)) {
        throw new TypeError("Invalid WhatsApp authentication credentials");
      }
      creds = parsed;
    } catch {
      authEpoch = await clearAuthState(storage);
      creds = initAuthCreds();
      authReset = true;
    }
  } else {
    creds = initAuthCreds();
  }
  let localBaseline = cloneAuthenticationCreds(creds);

  return {
    authReset,
    state: {
      creds,
      keys: createDOSignalKeyStore(storage, authEpoch),
    },
    saveCreds: async () => {
      const desired = cloneAuthenticationCreds(creds);
      await storage.transaction(async (txn) => {
        await assertAuthEpoch(txn, authEpoch);
        const latest = storedAuthenticationCreds(
          await txn.get<string>(CREDS_KEY),
          localBaseline,
        );
        await txn.put(
          CREDS_KEY,
          serializeAuthValue(mergeCredentialChanges(localBaseline, desired, latest)),
        );
      });
      // Keep this socket's own baseline, not the merged durable value. Another
      // overlapping socket may have changed fields that are absent from this
      // socket's in-memory snapshot; treating those as local removals on the
      // next save would reintroduce the stale-snapshot race.
      localBaseline = desired;
    },
  };
}

function storedAuthenticationCreds(
  stored: string | undefined,
  fallback: AuthenticationCreds,
): AuthenticationCreds {
  if (stored !== undefined) {
    try {
      const parsed = deserializeAuthValue(stored);
      if (isAuthenticationCreds(parsed)) return parsed;
    } catch {
      // A valid local snapshot can repair a corrupt credential record below.
    }
  }
  return cloneAuthenticationCreds(fallback);
}

/** Merge only this socket's changes onto the latest durable credential record. */
function mergeCredentialChanges(
  baseline: AuthenticationCreds,
  desired: AuthenticationCreds,
  latest: AuthenticationCreds,
): AuthenticationCreds {
  const merged = cloneAuthenticationCreds(latest);
  // SAFETY: AuthenticationCreds is a JSON object and its fields are merged by name.
  const baselineRecord = baseline as AuthValueObject;
  // SAFETY: AuthenticationCreds is a JSON object and its fields are merged by name.
  const desiredRecord = desired as AuthValueObject;
  // SAFETY: AuthenticationCreds is a JSON object and its fields are merged by name.
  const mergedRecord = merged as AuthValueObject;
  const keys = new Set([...Object.keys(baselineRecord), ...Object.keys(desiredRecord)]);

  for (const key of keys) {
    const baselineValue = Object.entries(baselineRecord).find(([name]) => name === key)?.[1];
    const desiredValue = Object.entries(desiredRecord).find(([name]) => name === key)?.[1];
    if (serializedField(baselineValue) === serializedField(desiredValue)) continue;
    if (Object.hasOwn(desiredRecord, key)) {
      Object.defineProperty(mergedRecord, key, { value: desiredValue, enumerable: true, writable: true, configurable: true });
    } else {
      Object.defineProperty(mergedRecord, key, { value: undefined, enumerable: false, writable: true, configurable: true });
    }
  }
  return merged;
}

function cloneAuthenticationCreds(creds: AuthenticationCreds): AuthenticationCreds {
  const cloned = deserializeAuthValue(serializeAuthValue(creds));
  if (!isRecord(cloned)) throw new TypeError("Invalid cloned credentials");
  // SAFETY: The source value is already Baileys AuthenticationCreds; serialization only clones it.
  return cloned as AuthenticationCreds;
}

function serializedField(value: AuthValue): string {
  // SAFETY: The wrapper is an internal JSON object used to preserve undefined fields.
  const wrapper = Object.create(null) as AuthValueObject;
  Reflect.set(wrapper, "value", value);
  return serializeAuthValue(wrapper);
}

export async function clearAuthState(storage: DurableObjectStorage): Promise<number> {
  return await storage.transaction(async (txn) => {
    const nextEpoch = normalizeAuthEpoch(await txn.get<number>(AUTH_EPOCH_KEY)) + 1;
    await txn.put(AUTH_EPOCH_KEY, nextEpoch);
    await txn.delete(CREDS_KEY);
    const entries = await txn.list({ prefix: SIGNAL_PREFIX });
    for (const keyChunk of chunk([...entries.keys()])) {
      await txn.delete(keyChunk);
    }
    return nextEpoch;
  });
}

export async function hasAuthState(storage: DurableObjectStorage): Promise<boolean> {
  return await storage.get(CREDS_KEY) !== undefined;
}

export async function hasRegisteredAuthState(
  storage: DurableObjectStorage,
): Promise<boolean> {
  const storedCreds = await storage.get<string>(CREDS_KEY);
  if (storedCreds === undefined) return false;
  try {
    const creds = deserializeAuthValue(storedCreds);
    return isAuthenticationCreds(creds) && creds.registered;
  } catch {
    return false;
  }
}

function isAuthenticationCreds(value: AuthValue): value is AuthenticationCreds {
  if (!isRecord(value)) return false;
  if (!isKeyPair(value.noiseKey)) return false;
  if (!isKeyPair(value.pairingEphemeralKeyPair)) return false;
  if (!isKeyPair(value.signedIdentityKey)) return false;
  if (!isSignedKeyPair(value.signedPreKey)) return false;
  if (!isNonNegativeSafeInteger(value.registrationId)) return false;
  if (!isStringValue(value.advSecretKey) || value.advSecretKey.length === 0) {
    return false;
  }
  if (!Array.isArray(value.processedHistoryMessages)) return false;
  if (!isNonNegativeSafeInteger(value.nextPreKeyId)) return false;
  if (!isNonNegativeSafeInteger(value.firstUnuploadedPreKeyId)) return false;
  if (!isNonNegativeSafeInteger(value.accountSyncCounter)) return false;
  if (!isRecord(value.accountSettings)) return false;
  if (!isBooleanValue(value.accountSettings.unarchiveChats)) return false;
  if (
    value.accountSettings.defaultDisappearingMode !== undefined
    && !isRecord(value.accountSettings.defaultDisappearingMode)
  ) return false;
  if (!isBooleanValue(value.registered)) return false;
  if (!isOptionalString(value.pairingCode)) return false;
  if (!isOptionalString(value.lastPropHash)) return false;
  if (value.routingInfo !== undefined && !isByteArray(value.routingInfo)) return false;
  if (!isOptionalString(value.myAppStateKeyId)) return false;
  if (!isOptionalString(value.platform)) return false;
  if (
    value.lastAccountSyncTimestamp !== undefined
    && !isNonNegativeSafeInteger(value.lastAccountSyncTimestamp)
  ) return false;
  if (value.account !== undefined && !isRecord(value.account)) return false;
  if (value.me !== undefined && !isWhatsAppContact(value.me)) return false;
  if (value.registered && !isWhatsAppContact(value.me)) return false;
  if (
    value.signalIdentities !== undefined
    && (!Array.isArray(value.signalIdentities)
      || !value.signalIdentities.every(isSignalIdentity))
  ) return false;
  return true;
}

function isRecord(value: AuthValue): value is AuthValueObject {
  return authObjectSchema.safeParse(value).success;
}

function isByteArray(value: AuthValue): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength > 0;
}

function isKeyPair(value: AuthValue): boolean {
  return isRecord(value)
    && isByteArray(value.public)
    && isByteArray(value.private);
}

function isSignedKeyPair(value: AuthValue): boolean {
  return isRecord(value)
    && isKeyPair(value.keyPair)
    && isByteArray(value.signature)
    && isNonNegativeSafeInteger(value.keyId)
    && (value.timestampS === undefined || isNonNegativeSafeInteger(value.timestampS));
}

function isWhatsAppContact(value: AuthValue): boolean {
  return isRecord(value) && isStringValue(value.id) && value.id.length > 0;
}

function isSignalIdentity(value: AuthValue): boolean {
  return isRecord(value)
    && isRecord(value.identifier)
    && isStringValue(value.identifier.name)
    && isNonNegativeSafeInteger(value.identifier.deviceId)
    && isByteArray(value.identifierKey);
}

function isOptionalString(value: AuthValue | undefined): boolean {
  return value === undefined || isStringValue(value);
}

function isNonNegativeSafeInteger(value: AuthValue): value is number {
  return isNumberValue(value) && value >= 0;
}

function isNumberValue(value: AuthValue): value is number {
  return Number.isSafeInteger(value);
}

function isStringValue(value: AuthValue | undefined): value is string {
  return value !== undefined && String(value) === value;
}

function isBooleanValue(value: AuthValue): value is boolean {
  return value === true || value === false;
}

function normalizeAuthEpoch(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}
