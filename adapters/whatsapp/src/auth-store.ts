/**
 * DO-based authentication state store for Baileys
 * Replaces the file-based useMultiFileAuthState with Durable Object storage
 */

import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalKeyStore,
  SignalKeyStoreWithTransaction,
} from "@whiskeysockets/baileys";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";

type StorageKV = DurableObjectStorage;

const serializeAuthValue = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
const deserializeAuthValue = (value: string): unknown => JSON.parse(value, authValueReviver);

function authValueReviver(key: string, value: unknown): unknown {
  const revived = BufferJSON.reviver(key, value);
  if (revived !== value) return revived;

  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type?: unknown }).type === "Buffer" &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data);
  }

  return value;
}

/**
 * Create a SignalKeyStore backed by DO storage
 */
function createDOSignalKeyStore(storage: StorageKV): SignalKeyStoreWithTransaction {
  const PREFIX = "signal:";

  const store: SignalKeyStoreWithTransaction = {
    async get<T extends keyof import("@whiskeysockets/baileys").SignalDataTypeMap>(
      type: T,
      ids: string[],
    ) {
      const result: Record<string, unknown> = {};
      for (const id of ids) {
        const key = `${PREFIX}${type}:${id}`;
        const value = await storage.get<string>(key);
        if (value) {
          try {
            result[id] = deserializeAuthValue(value);
          } catch {
            // Invalid JSON, skip
          }
        }
      }
      return result as any;
    },

    async set(data: SignalDataSet): Promise<void> {
      const puts: Record<string, string> = {};
      const deletes: string[] = [];
      for (const [type, entries] of Object.entries(data)) {
        if (!entries) continue;
        for (const [id, value] of Object.entries(entries)) {
          const key = `${PREFIX}${type}:${id}`;
          if (value) {
            puts[key] = serializeAuthValue(value);
          } else {
            deletes.push(key);
          }
        }
      }
      await Promise.all([
        Object.keys(puts).length > 0 ? storage.put(puts) : Promise.resolve(),
        deletes.length > 0 ? storage.delete(deletes) : Promise.resolve(),
      ]);
    },

    async clear(): Promise<void> {
      // List all keys with prefix and delete them
      const entries = await storage.list({ prefix: PREFIX });
      const keys = [...entries.keys()];
      if (keys.length > 0) {
        await storage.delete(keys);
      }
    },

    // Transaction support - for atomic operations
    isInTransaction(): boolean {
      return false;
    },

    async transaction<T>(
      exec: () => Promise<T>,
    ): Promise<T> {
      // DO storage is already transactional per operation
      // For true transactions, we'd need to batch operations
      return await exec();
    },
  };

  return store;
}

/**
 * Create an AuthenticationState backed by DO storage
 * This replaces useMultiFileAuthState for Workers/DO environment
 */
export async function useDOAuthState(
  storage: StorageKV,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const CREDS_KEY = "auth:creds";

  // Load or initialize credentials
  let creds: AuthenticationCreds;
  const storedCreds = await storage.get<string>(CREDS_KEY);
  
  if (storedCreds) {
    try {
      creds = deserializeAuthValue(storedCreds) as AuthenticationCreds;
      console.log("[AuthStore] Loaded stored creds");
    } catch (e) {
      console.log("[AuthStore] Invalid stored creds, initializing new:", e);
      creds = initAuthCreds();
    }
  } else {
    console.log("[AuthStore] No stored creds, initializing new");
    creds = initAuthCreds();
  }

  // Create key store
  const keys = createDOSignalKeyStore(storage);

  // Save credentials function
  const saveCreds = async () => {
    await storage.put(CREDS_KEY, serializeAuthValue(creds));
    console.log("[AuthStore] Credentials saved");
  };

  return {
    state: {
      creds,
      keys,
    },
    saveCreds,
  };
}

/**
 * Clear all auth state from storage (for logout)
 */
export async function clearAuthState(storage: StorageKV): Promise<void> {
  // Delete credentials
  await storage.delete("auth:creds");
  
  // Delete all signal keys
  const entries = await storage.list({ prefix: "signal:" });
  const keys = [...entries.keys()];
  if (keys.length > 0) {
    await storage.delete(keys);
  }
  
  console.log("[AuthStore] Auth state cleared");
}

/**
 * Check if auth state exists
 */
export async function hasAuthState(storage: StorageKV): Promise<boolean> {
  const creds = await storage.get("auth:creds");
  return creds !== undefined;
}
