import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from "@whiskeysockets/baileys";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";

const CREDS_KEY = "auth:creds";
const AUTH_EPOCH_KEY = "auth:epoch";
const SIGNAL_PREFIX = "signal:";
const STORAGE_BATCH_SIZE = 128;

const serializeAuthValue = (value: unknown): string =>
  JSON.stringify(value, BufferJSON.replacer);

const deserializeAuthValue = (value: string): unknown =>
  JSON.parse(value, authValueReviver);

function authValueReviver(key: string, value: unknown): unknown {
  const revived = BufferJSON.reviver(key, value);
  if (revived !== value) return revived;

  if (
    value
    && typeof value === "object"
    && "type" in value
    && (value as { type?: unknown }).type === "Buffer"
    && "data" in value
    && Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data);
  }

  return value;
}

function chunk<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += STORAGE_BATCH_SIZE) {
    chunks.push(items.slice(index, index + STORAGE_BATCH_SIZE));
  }
  return chunks;
}

function createDOSignalKeyStore(
  storage: DurableObjectStorage,
  authEpoch: number,
): SignalKeyStore {
  return {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const idChunk of chunk(ids)) {
        const storageKeys = idChunk.map((id) => `${SIGNAL_PREFIX}${type}:${id}`);
        const values = await storage.transaction(async (txn) => {
          if (normalizeAuthEpoch(await txn.get<number>(AUTH_EPOCH_KEY)) !== authEpoch) {
            return new Map<string, string>();
          }
          return await txn.get<string>(storageKeys);
        });
        for (const [index, id] of idChunk.entries()) {
          const stored = values.get(storageKeys[index]);
          if (stored === undefined) continue;
          try {
            result[id] = deserializeAuthValue(stored) as SignalDataTypeMap[T];
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
        if (normalizeAuthEpoch(await txn.get<number>(AUTH_EPOCH_KEY)) !== authEpoch) {
          return;
        }
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
        if (normalizeAuthEpoch(await txn.get<number>(AUTH_EPOCH_KEY)) !== authEpoch) {
          return;
        }
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
  let authEpoch = normalizeAuthEpoch(await storage.get<number>(AUTH_EPOCH_KEY));
  const storedCreds = await storage.get<string>(CREDS_KEY);

  if (storedCreds) {
    try {
      creds = deserializeAuthValue(storedCreds) as AuthenticationCreds;
    } catch {
      authEpoch = await clearAuthState(storage);
      creds = initAuthCreds();
      authReset = true;
    }
  } else {
    creds = initAuthCreds();
  }

  return {
    authReset,
    state: {
      creds,
      keys: createDOSignalKeyStore(storage, authEpoch),
    },
    saveCreds: async () => {
      await storage.transaction(async (txn) => {
        if (normalizeAuthEpoch(await txn.get<number>(AUTH_EPOCH_KEY)) !== authEpoch) {
          return;
        }
        await txn.put(CREDS_KEY, serializeAuthValue(creds));
      });
    },
  };
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
  if (!storedCreds) return false;
  try {
    return (deserializeAuthValue(storedCreds) as AuthenticationCreds).registered === true;
  } catch {
    return false;
  }
}

function normalizeAuthEpoch(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}
