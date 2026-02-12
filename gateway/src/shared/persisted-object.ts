type Options<T extends Record<string, unknown>> = {
  /** Prefix all keys */
  prefix?: string;
  /** Auto-save nested mutations (default: true). When false, warns instead. */
  autoSave?: boolean;
  /** Default values for properties when not in KV */
  defaults?: Partial<T>;
};

declare const __proxied: unique symbol;

/**
 * Branded wrapper for PersistedObject values.
 * Use `snapshot(obj)` to obtain a deep-cloned plain `T` safe for
 * RPC / structured clone boundaries.
 */
export type Proxied<T> = T & { [__proxied]: true };

/**
 * Deep-clone a Proxied object, stripping all Proxy wrappers.
 * Returns a plain T safe for structured clone / RPC.
 */
export function snapshot<T extends Record<string, unknown>>(obj: Proxied<T>): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

const INTERNAL = Symbol("kv-state:internal");
const PERSISTED_REF = "__persistedRef__";

export function PersistedObject<T extends Record<string, unknown>>(
  kv: SyncKvStorage,
  opts: Options<T> = {}
): Proxied<T> {
  const prefix = opts.prefix ?? "";
  const autoSave = opts.autoSave ?? true;
  const defaults = opts.defaults ?? ({} as Record<string, unknown>);
  const cache = new Map<string, unknown>();

  const keyOf = (prop: string) => prefix + prop;

  const helpers: Record<typeof INTERNAL, unknown> = {
    [INTERNAL]: { kv, cache, prefix, opts }
  };

    function areValuesEqual(a: any, b: any): boolean {
    // Same reference or both primitive and equal
    if (a === b) return true;

    // Different types or one is null/undefined
    if (typeof a !== typeof b || a === null || b === null) return false;

    // If not objects, they're not equal (already checked === above)
    if (typeof a !== "object" || typeof b !== "object") return false;

    // Both are PersistedObjects - compare their prefixes
    if (INTERNAL in a && INTERNAL in b) {
      return a[INTERNAL].prefix === b[INTERNAL].prefix;
    }

    // One is PersistedObject, other isn't
    if (INTERNAL in a !== INTERNAL in b) return false;

    // Both are persisted refs - compare ref values
    if (a[PERSISTED_REF] && b[PERSISTED_REF]) {
      return a[PERSISTED_REF] === b[PERSISTED_REF];
    }

    return false;
  }

  const MUTATING_ARRAY_METHODS = new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
    "sort",
    "reverse",
    "fill",
    "copyWithin"
  ]);

  function wrapWithAutoSave(
    value: any,
    propName: string,
    onMutate: () => void
  ): any {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (INTERNAL in value) return value; // Already a PersistedObject
    if (value[PERSISTED_REF]) return value; // Already marked as ref

    function createDeepProxy(obj: any): any {
      if (obj === null || typeof obj !== "object") return obj;

      return new Proxy(obj, {
        get(target, prop, receiver) {
          const val = Reflect.get(target, prop, receiver);

          // Wrap array mutating methods
          if (Array.isArray(target) && typeof val === "function") {
            if (MUTATING_ARRAY_METHODS.has(String(prop))) {
              return function (...args: any[]) {
                const result = val.apply(target, args);
                onMutate();
                return result;
              };
            }
            return val.bind(target);
          }

          // Recursively proxy nested objects/arrays
          if (val !== null && typeof val === "object") {
            return createDeepProxy(val);
          }
          return val;
        },

        set(target, prop, newValue) {
          const result = Reflect.set(target, prop, newValue);
          onMutate();
          return result;
        },

        deleteProperty(target, prop) {
          const result = Reflect.deleteProperty(target, prop);
          onMutate();
          return result;
        }
      });
    }

    return createDeepProxy(value);
  }

  function wrapWithMutationWarning(value: any, propName: string): any {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (INTERNAL in value) return value; // Already a PersistedObject
    if (value[PERSISTED_REF]) return value; // Already marked as ref

    return new Proxy(value, {
      set(target, prop, val) {
        console.warn(
          `⚠️ Persisted Object: Mutation detected on ${propName}.${String(prop)}. ` +
            `This will NOT persist. Use reassignment: obj.${propName} = { ...obj.${propName}, ${String(prop)}: value }`
        );
        return Reflect.set(target, prop, val);
      },
      deleteProperty(target, prop) {
        console.warn(
          `⚠️ Persisted Object: Delete detected on ${propName}.${String(prop)}. ` +
            "This will NOT persist. Use reassignment to remove properties."
        );
        return Reflect.deleteProperty(target, prop);
      }
    });
  }

  const target: any = helpers;

  const handler: ProxyHandler<any> = {
    get(_t, prop, _r) {
      if (typeof prop !== "string") {
        // Preserve default behavior for symbols like inspect, iterator, etc.
        return Reflect.get(target, prop);
      }
      if (prop in target) return target[prop];

      const k = keyOf(prop);
      if (cache.has(k)) return cache.get(k);

      const v = kv.get(k);

      // Handle nested PersistedObject references
      if (v && typeof v === "object" && PERSISTED_REF in v) {
        const nested = PersistedObject(kv, {
          prefix: (v as any)[PERSISTED_REF],
          autoSave
        });
        cache.set(k, nested);
        return nested;
      }

      // If no value in KV, check for default
      const valueToWrap = v !== undefined ? v : defaults[prop];

      // Wrap arrays/objects with auto-save or mutation warning
      if (autoSave) {
        const wrapped = wrapWithAutoSave(valueToWrap, prop, () => {
          kv.put(k, valueToWrap);
        });
        cache.set(k, wrapped);
        return wrapped;
      } else {
        const wrapped = wrapWithMutationWarning(valueToWrap, prop);
        cache.set(k, wrapped);
        return wrapped;
      }
    },

    set(_t, prop, value) {
      if (typeof prop !== "string") return false;
      if (prop in target) {
        throw new Error(`Cannot assign to helper property "${prop}"`);
      }
      const k = keyOf(prop);

      // Check if the value is already in cache and unchanged
      if (cache.has(k)) {
        const cachedValue = cache.get(k);
        if (areValuesEqual(cachedValue, value)) {
          // Value hasn't changed, skip the write
          return true;
        }
      }

      if (value === undefined) {
        // Treat setting to undefined as a delete, which is usually what you want.
        kv.delete(k);
        cache.delete(k);
      } else {
        // Check if value is a nested PersistedObject
        if (value && typeof value === "object" && INTERNAL in value) {
          const nestedMeta = (value as any)[INTERNAL];
          // Store a reference instead of duplicating data
          kv.put(k, { [PERSISTED_REF]: nestedMeta.prefix });
          cache.set(k, value);
        } else {
          kv.put(k, value);
          if (autoSave) {
            cache.set(
              k,
              wrapWithAutoSave(value, prop, () => {
                kv.put(k, value);
              })
            );
          } else {
            cache.set(k, wrapWithMutationWarning(value, prop));
          }
        }
      }
      return true;
    },

    deleteProperty(_t, prop) {
      if (typeof prop !== "string") return false;
      if (prop in target) return false;
      const k = keyOf(prop);
      kv.delete(k);
      cache.delete(k);
      return true;
    },

    has(_t, prop) {
      if (typeof prop !== "string") return prop in target;
      if (prop in target) return true;
      const k = keyOf(prop);
      // Check cache first
      if (cache.has(k)) return true;
      // Check KV storage
      if (kv.get(k) !== undefined) return true;
      // Check defaults
      if (prop in defaults) return true;
      return false;
    },

    ownKeys() {
      if (typeof kv.list === "function") {
        const listed = kv.list({ prefix });
        const fromKv = Array.isArray(listed) ? listed : Array.from(listed);
        return Array.from(
          new Set([
            // kv.list() returns [key, value] tuples, so extract just the key
            ...fromKv.map((entry) => {
              const key = Array.isArray(entry) ? entry[0] : entry;
              return typeof key === "string" ? key.slice(prefix.length) : key;
            }),
            ...Array.from(cache.keys())
              .filter((k) => k.startsWith(prefix))
              .map((k) => k.slice(prefix.length))
          ])
        );
      }
      return Array.from(cache.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },

    getOwnPropertyDescriptor(_t, prop) {
      // Mark properties enumerable so they show up in Object.keys.
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (target as any)[prop as any]
      };
    }
  };

  return new Proxy(target, handler) as Proxied<T>;
}
