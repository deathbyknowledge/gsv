/**
 * DO-based authentication state store for Baileys
 * Replaces the file-based useMultiFileAuthState with Durable Object storage
 */

import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalKeyStore,
  SignalKeyStoreWithTransaction,
} from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import { initAuthCreds } from "@whiskeysockets/baileys";

type StorageKV = DurableObjectStorage;

/**
 * JSON replacer that converts Buffers to a serializable format
 */
function bufferReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      data: Array.from(value),
    };
  }
  // Handle Uint8Array as well
  if (value instanceof Uint8Array) {
    return {
      type: "Buffer",
      data: Array.from(value),
    };
  }
  return value;
}

/**
 * JSON reviver that converts serialized Buffers back to Buffer objects
 */
function bufferReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as any).type === "Buffer" &&
    "data" in value &&
    Array.isArray((value as any).data)
  ) {
    return Buffer.from((value as any).data);
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
            result[id] = JSON.parse(value, bufferReviver);
          } catch {
            // Invalid JSON, skip
          }
        }
      }
      return result as any;
    },

    async set(data: Record<string, Record<string, unknown>>): Promise<void> {
      const puts: Record<string, string> = {};
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const key = `${PREFIX}${type}:${id}`;
          puts[key] = JSON.stringify(value, bufferReplacer);
        }
      }
      await storage.put(puts);
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
      creds = JSON.parse(storedCreds, bufferReviver);
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
    await storage.put(CREDS_KEY, JSON.stringify(creds, bufferReplacer));
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
