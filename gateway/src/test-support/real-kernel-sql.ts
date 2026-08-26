/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Kernel } from "../kernel/do";

export async function runWithRealKernelSql<T>(
  callback: (
    sql: SqlStorage,
    storage: DurableObjectStorage,
  ) => T | Promise<T>,
): Promise<T> {
  const id = env.KERNEL.idFromName(crypto.randomUUID());
  const stub = env.KERNEL.get(id);

  return runInDurableObject(stub, (_instance: Kernel, state) =>
    callback(state.storage.sql, state.storage),
  );
}
