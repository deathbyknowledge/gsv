import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { z } from "zod";

const receiptSchema = z.object({ installationId: z.string(), processId: z.string(), logicalRequestId: z.string(), version: z.literal(1),
  writerId: z.string(), phase: z.enum(["awaiting-arm", "capturing", "held", "releasing", "delivered", "rejected", "inconclusive"]),
  byteLength: z.number().optional(), bufferedBytes: z.number(), sha256: z.string().optional(), cancellationObservedAt: z.number().optional(),
  deadlineAt: z.number(), timeoutMs: z.number(), terminal: z.object({ provider: z.string(), model: z.string(), outputTokens: z.number() }).optional(),
  abort: z.object({ reason: z.enum(["cancelled", "timeout"]), observedAt: z.number(), forwardedAt: z.number().optional() }).optional(),
  releaseAttemptedAt: z.number().optional(), reason: z.string().optional() });

const fixtureText = JSON.stringify({ type: "done", reason: "stop", message: {
  role: "assistant", content: [{ type: "text", text: "local upstream completed once" }], api: "local",
  provider: "local-fixture", model: "no-provider", stopReason: "stop", timestamp: 1,
  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} }) + "\n";
const base = { compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"] };
const relay = resolve(import.meta.dirname, "../acceptance/delayed-inference/relay.ts");
const controller = resolve(import.meta.dirname, "../acceptance/delayed-inference/controller.ts");
const probe = resolve(import.meta.dirname, "fixtures/delayed-inference-probe.ts");

describe("delayed inference's original stream across real workerd RPC", () => {
  let harness: ReturnType<typeof createTestHarness>;
  afterEach(async () => { await harness?.close(); });
  async function start(leaseMs = 30000, armMs = 10000) {
    harness = createTestHarness({ root: resolve(import.meta.dirname, ".."), workers: [
      { config: { ...base, name: "delayed-relay", main: relay,
        vars: { DELAY_INSTALLATION_ID: "inst_disposable", DELAY_PROCESS_ID: "proc_disposable", DELAY_MAX_BYTES: 4096,
          DELAY_PROVIDER: "local-fixture", DELAY_MODEL: "no-provider", DELAY_ARM_TIMEOUT_MS: armMs,
          DELAY_CAPTURE_TIMEOUT_MS: 10000, DELAY_LEASE_TIMEOUT_MS: leaseMs },
        durable_objects: { bindings: [{ name: "DELAY_RELAYS", class_name: "DelayedStream" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["DelayedStream"] }],
        services: [{ binding: "INFERENCE_REAL", service: "delayed-probe", entrypoint: "LocalUpstream" }] } },
      { config: { ...base, name: "delayed-probe", main: probe,
        durable_objects: { bindings: [{ name: "CALLERS", class_name: "Caller" }, { name: "CONTROLLERS", class_name: "Controller" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Caller", "Controller"] }], services: [
        { binding: "CONTROL", service: "delayed-relay", entrypoint: "DelayedControl", props: { authority: "delayed-inference-acceptance" } },
        { binding: "RELAY", service: "delayed-relay" },
        { binding: "UPSTREAM", service: "delayed-probe", entrypoint: "LocalUpstream" },
      ] } },
      { config: { ...base, name: "delayed-controller", main: controller,
        vars: { CONTROL_SECRET: "a".repeat(64), CONTROL_ORIGIN: "https://control.invalid", LEASE_TIMEOUT_MS: 30000,
          DELAY_INSTALLATION_ID: "inst_disposable", DELAY_PROCESS_ID: "proc_disposable" },
        services: [{ binding: "CONTROL", service: "delayed-relay", entrypoint: "DelayedControl", props: { authority: "delayed-inference-acceptance" } }] } },
    ] });
    await harness.listen();
  }
  const call = (path: string, id: string) => harness.getWorker("delayed-probe").fetch(`https://fixture.invalid/${path}?id=${id}`, { headers: { "accept-encoding": "identity" } });
  async function status(id: string) { return receiptSchema.parse(await (await call("status", id)).json()); }
  async function receive(id: string) {
    expect(await (await call("generation", id)).text()).toBe("started");
    expect(await (await call("inspect", id)).json()).toMatchObject({ phase: "awaiting-arm", logicalRequestId: id, processId: "proc_disposable" });
    expect(await (await call("upstream", id)).json()).toBeNull();
  }
  async function begin(id: string) {
    await receive(id);
    expect(await (await call("lease", id)).text()).toBe("lease-open\n");
    await expect.poll(async () => (await status(id)).phase).toBe("held");
    const captured = await status(id);
    expect(captured).toMatchObject({ byteLength: Buffer.byteLength(fixtureText),
      sha256: createHash("sha256").update(fixtureText).digest("hex"),
      terminal: { provider: "local-fixture", model: "no-provider", outputTokens: 3 } });
    return captured;
  }

  const control = (path: string, body: Record<string, string>, authorization = `Bearer ${"a".repeat(64)}`) =>
    harness.getWorker("delayed-controller").fetch(`https://control.invalid/${path}`, { method: "POST",
      headers: { authorization, origin: "https://control.invalid", "content-type": "application/json", "accept-encoding": "identity" }, body: JSON.stringify(body) });

  it("requires authenticated exact scope and preserves the original stream through an independent HTTP lease", async () => {
    await start();
    await receive("http-control");
    const scope = { installationId: "inst_disposable", logicalRequestId: "http-control" };
    expect((await control("lease", scope, "")).status).toBe(403);
    expect((await control("lease", { ...scope, installationId: "inst_other" })).status).toBe(400);
    expect((await control("lease", { ...scope, logicalRequestId: "unknown" })).status).toBe(409);
    expect(await (await call("upstream", "http-control")).json()).toBeNull();
    expect(await (await control("inspect", { installationId: "inst_disposable", processId: "proc_disposable" })).json()).toMatchObject({ phase: "awaiting-arm" });
    const response = await control("lease", scope);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("lease-open");
    try {
      await expect.poll(async () => (await status("http-control")).phase).toBe("held");
      await call("cancel", "http-control");
      const receipt = receiptSchema.parse(await (await control("release", scope)).json());
      expect(receipt).toMatchObject({ phase: "rejected", bufferedBytes: 0, abort: { reason: "cancelled" } });
      expect(receipt.abort!.observedAt).toBeLessThan(receipt.deadlineAt);
      expect(receipt.abort!.forwardedAt).toBeLessThan(receipt.deadlineAt);
      expect(receipt.releaseAttemptedAt).toBeLessThan(receipt.deadlineAt);
    } finally { await reader.cancel(); }
  });

  it("treats authenticated HTTP controller disconnect as inconclusive", async () => {
    await start();
    await receive("http-disconnect");
    const response = await control("lease", { installationId: "inst_disposable", logicalRequestId: "http-disconnect" });
    const reader = response.body!.getReader();
    await reader.read();
    await expect.poll(async () => (await status("http-disconnect")).phase).toBe("held");
    await reader.cancel();
    await expect.poll(async () => (await status("http-disconnect")).phase).toBe("inconclusive");
    expect(await status("http-disconnect")).toMatchObject({ reason: "lease-lost", bufferedBytes: 0 });
  });

  it("requires explicit confirmation of the observed ID before delivering through its original writer", async () => {
    await start();
    await receive("positive");
    await expect(call("lease", "wrong-id")).rejects.toThrow("Logical request was not observed");
    expect(await (await call("upstream", "positive")).json()).toBeNull();
    expect(await (await call("lease", "positive")).text()).toBe("lease-open\n");
    await expect.poll(async () => (await status("positive")).phase).toBe("held");
    const captured = await status("positive");
    try {
      expect(await (await call("release", "positive")).json()).toMatchObject({ phase: "delivered", writerId: captured.writerId, bufferedBytes: 0 });
      await expect.poll(async () => (await call("result", "positive")).json()).toMatchObject({ text: fixtureText, receivedBytes: Buffer.byteLength(fixtureText), streamFailed: false, disposedHandleRejected: true });
      expect((await status("positive")).cancellationObservedAt).toBeUndefined();
      await expect.poll(async () => (await call("upstream", "positive")).json()).toMatchObject({ generations: 1, aborts: [] });
    } finally { await call("disconnect", "positive"); }
  });

  it("retains the SAME writer after caller cancellation and lets that stream reject release before its deadline", async () => {
    await start();
    const captured = await begin("cancelled");
    try {
      await call("cancel", "cancelled");
      expect(await status("cancelled")).toMatchObject({ phase: "held", writerId: captured.writerId });
      const receipt = receiptSchema.parse(await (await call("release", "cancelled")).json());
      expect(receipt).toMatchObject({ phase: "rejected", writerId: captured.writerId, sha256: captured.sha256, bufferedBytes: 0 });
      expect(receipt.releaseAttemptedAt).toBeTypeOf("number");
      expect(receipt.abort).toMatchObject({ reason: "cancelled", forwardedAt: expect.any(Number) });
      expect(receipt.abort!.observedAt).toBeLessThan(receipt.deadlineAt);
      expect(receipt.abort!.forwardedAt).toBeLessThan(receipt.deadlineAt);
      expect(receipt.releaseAttemptedAt).toBeLessThan(receipt.deadlineAt);
      await expect.poll(async () => (await call("upstream", "cancelled")).json()).toMatchObject({ generations: 1, aborts: ["cancelled"] });
      expect(await (await call("result", "cancelled")).json()).toMatchObject({ receivedBytes: 0, cancelledAt: expect.any(Number), disposedHandleRejected: true });
    } finally { await call("disconnect", "cancelled"); }
  });

  it("reports a lost independent control lease as inconclusive without reconstructing a writer", async () => {
    await start();
    const captured = await begin("lost-lease");
    await call("disconnect", "lost-lease");
    await expect.poll(async () => (await status("lost-lease")).phase).toBe("inconclusive");
    expect(await (await call("release", "lost-lease")).json()).toMatchObject({ phase: "inconclusive", reason: "lease-lost", writerId: captured.writerId, bufferedBytes: 0 });
    expect((await status("lost-lease")).releaseAttemptedAt).toBeUndefined();
  });

  it("expires an unconfirmed pending request without making a provider call", async () => {
    await start(30000, 200);
    await receive("not-confirmed");
    await expect.poll(async () => (await status("not-confirmed")).phase).toBe("inconclusive");
    expect(await status("not-confirmed")).toMatchObject({ reason: "arm-expired", bufferedBytes: 0 });
    expect(await (await call("upstream", "not-confirmed")).json()).toBeNull();
    await expect(call("lease", "not-confirmed")).rejects.toThrow("Original pending request is unavailable");
  });

  it("bounds an independently held control lease and clears its bytes", async () => {
    await start(700);
    await begin("expired-lease");
    await expect.poll(async () => (await status("expired-lease")).phase).toBe("inconclusive");
    expect(await status("expired-lease")).toMatchObject({ reason: "lease-expired", bufferedBytes: 0 });
  });

  it("does not accept arbitrary EOF bytes as a successful native completion", async () => {
    await start();
    await receive("bad-terminal");
    await call("lease", "bad-terminal");
    await expect.poll(async () => (await status("bad-terminal")).phase).toBe("inconclusive");
    expect(await status("bad-terminal")).toMatchObject({ reason: "capture-failed", bufferedBytes: 0 });
    expect((await status("bad-terminal")).terminal).toBeUndefined();
  });
});
