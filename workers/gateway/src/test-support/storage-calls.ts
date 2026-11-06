export type StorageCall = { method: string; key: string; started: number; settled?: number };

/** Records each storage call with the order in which it started and settled. */
export function recordStorageCalls(bucket: R2Bucket): { bucket: R2Bucket; calls: StorageCall[] } {
  const calls: StorageCall[] = [];
  let clock = 0;
  const recorded = new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const [first] = args;
        const call: StorageCall = {
          method: String(property),
          key: typeof first === "string" ? first
            : typeof first === "object" && first !== null && "prefix" in first ? String(first.prefix) : "",
          started: clock++,
        };
        calls.push(call);
        return Promise.resolve(Reflect.apply(value, target, args)).finally(() => {
          call.settled = clock++;
        });
      };
    },
  });
  return { bucket: recorded, calls };
}
