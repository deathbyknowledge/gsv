import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import { z } from "zod";
import type { HostedRepo } from "../src/host/repo";

/** Parses a successful XRPC response with the schema a test expects. */
export async function read<T extends z.ZodType>(schema: T, response: Promise<Response>): Promise<z.output<T>> {
  const resolved = await response;
  if (!resolved.ok) throw new Error(`HTTP ${resolved.status}: ${await resolved.text()}`);
  return schema.parse(await resolved.json());
}

/** The message a call rejects with. Awaiting it here keeps assertions off an RPC promise's pipelined properties. */
export async function rejection<T>(call: Promise<T>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the call to reject");
}

/** The XRPC error name a failed call reports. */
export async function errorOf(response: Promise<Response>): Promise<string> {
  const resolved = await response;
  expect(resolved.ok).toBe(false);
  return z.object({ error: z.string() }).parse(await resolved.json()).error;
}

/** Runs a repository's alarm until the host firehose holds every event in its outbox. */
export async function deliver(repo: DurableObjectStub<HostedRepo>): Promise<void> {
  await vi.waitFor(async () => {
    await runDurableObjectAlarm(repo);
    expect(await runInDurableObject(repo, async (_instance, state) => {
      const delivered = (await state.storage.get<number>("firehose.delivered")) ?? 0;
      return state.storage.sql.exec<{ pending: number }>(
        "SELECT COUNT(*) AS pending FROM firehose_events WHERE seq > ?",
        delivered,
      ).one().pending;
    })).toBe(0);
  });
}
