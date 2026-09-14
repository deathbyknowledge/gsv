import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { administerOperatorBootstrap } from "../src/operator-bootstrap.ts";
import type { MigrationD1Row } from "../src/installation-migration-d1.ts";
import { deletionStackHarness, STACK } from "./fixtures/deletion-stack-harness.ts";

type Harness = ReturnType<typeof deletionStackHarness>;
type Worker = ReturnType<Harness["getWorker"]>;
type Socket = NonNullable<Awaited<ReturnType<Worker["fetch"]>>["webSocket"]>;
const jsonSchema = z.json();
const rpcSchema = z.object({ type: z.literal("res"), id: z.string(), ok: z.boolean(),
  data: jsonSchema.optional(), error: jsonSchema.optional() });
const origin = "https://accounts.example.invalid";

describe("public onboarding activation recovery", () => {
  let harness: Harness;
  let socket: Socket | undefined;
  beforeAll(async () => {
    harness = deletionStackHarness();
    await harness.listen();
    await harness.getWorker(STACK.accounts).applyD1Migrations("INSTALLATIONS_DB");
  });
  afterAll(async () => {
    if (socket?.readyState === 1) socket.close(1000, "test complete");
    await harness?.close();
  });

  it("finishes locally committed setup after an operator rotates its onboarding bearer", async () => {
    const accounts = harness.getWorker<{ INSTALLATIONS_DB: D1Database }>(STACK.accounts);
    const { INSTALLATIONS_DB: db } = await accounts.getEnv();
    const issued = await administerOperatorBootstrap({ action: "issue", mode: "operator", database: {
      identity: { accountId: "local", databaseId: "local" },
      async batch(statements) {
        const results = await db.batch<MigrationD1Row>(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params ?? [])));
        return results.map((result) => result.results);
      },
    } });
    if (!issued.secret) throw new Error("Bootstrap capability was not issued");
    const onboardingToken = `onboard_${Buffer.from(randomBytes(32)).toString("base64url")}`;
    const operatorToken = `operator_${Buffer.from(randomBytes(32)).toString("base64url")}`;
    const bootstrap = await accounts.fetch(`${origin}/bootstrap`, { method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ claim: issued.secret, handle: "onboarding-retry", onboardingToken, operatorToken }),
    });
    expect(bootstrap.status).toBe(200);
    const { installationId } = z.object({ installationId: z.string(), operatorAccess: z.literal(true) }).parse(await bootstrap.json());
    const originalClaim = await db.prepare("SELECT id, token_hash FROM installation_onboarding_claims WHERE installation_id = ?")
      .bind(installationId).first<{ id: string; token_hash: string }>();
    expect(originalClaim).not.toBeNull();

    const response = await harness.getWorker(STACK.gateway).fetch("https://onboarding-retry.example.invalid/ws", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error("Gateway WebSocket is unavailable");
    socket = response.webSocket;
    socket.accept();
    const credentials = { username: "retry-owner", password: "onboarding-recovery-fixture-password" };

    // Abort the real Accounts activation transaction after the Kernel commits local setup.
    await db.prepare(`CREATE TRIGGER acceptance_fail_activation BEFORE UPDATE OF state ON installations
      WHEN OLD.handle = 'onboarding-retry' AND NEW.state = 'active'
      BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END`).run();
    try {
      expect(await rpc(socket, "sys.setup", { ...credentials, onboardingToken })).toMatchObject({
        ok: false, error: { code: 503, message: "Installation setup could not be activated" },
      });
    } finally {
      await db.exec("DROP TRIGGER acceptance_fail_activation");
    }
    expect(await db.prepare("SELECT state FROM installations WHERE id = ?").bind(installationId).first())
      .toEqual({ state: "provisioning" });
    const kernel = await harness.getWorker(STACK.gateway).getDurableObjectStorage("KERNEL", { name: installationId });
    const localAccount = await kernel.exec("SELECT uid, home FROM passwd WHERE username = ?", credentials.username);
    expect(localAccount).toEqual([{ uid: 1000, home: "/home/retry-owner" }]);

    const reissued = await accounts.fetch(`${origin}/admin/api/installations/${installationId}/onboarding`, { method: "POST",
      headers: { origin, authorization: `Bearer ${operatorToken}`, "content-type": "application/json" }, body: "{}",
    });
    expect(reissued.status).toBe(200);
    const { onboarding } = z.object({ onboarding: z.object({ onboardingUrl: z.string() }) }).parse(await reissued.json());
    const rotatedToken = new URL(onboarding.onboardingUrl).hash.slice(1);
    expect(rotatedToken).not.toBe(onboardingToken);
    expect(await rpc(socket, "sys.setup", { ...credentials, onboardingToken })).toMatchObject({
      ok: false, error: { code: 401 },
    });
    expect(await rpc(socket, "sys.setup", { ...credentials, password: "wrong-fixture-password", onboardingToken: rotatedToken }))
      .toMatchObject({ ok: false });
    expect(await db.prepare("SELECT state FROM installations WHERE id = ?").bind(installationId).first())
      .toEqual({ state: "provisioning" });

    expect(await rpc(socket, "sys.setup", { ...credentials, onboardingToken: rotatedToken })).toMatchObject({ ok: true });
    expect(await db.prepare("SELECT state FROM installations WHERE id = ?").bind(installationId).first())
      .toEqual({ state: "active" });
    const completedClaim = await db.prepare("SELECT id, token_hash, completed_at FROM installation_onboarding_claims WHERE installation_id = ?")
      .bind(installationId).first<{ id: string; token_hash: string; completed_at: number | null }>();
    expect(completedClaim).toMatchObject({ id: originalClaim?.id, completed_at: expect.any(Number) });
    expect(completedClaim?.token_hash).not.toBe(originalClaim?.token_hash);
    expect(await kernel.exec("SELECT uid, home FROM passwd WHERE username = ?", credentials.username)).toEqual(localAccount);
    expect(await rpc(socket, "sys.connect", { protocol: 4,
      peer: { id: "onboarding-retry", version: "1", platform: "test" }, auth: credentials,
    })).toMatchObject({ ok: true });
  });
});

async function rpc(socket: Socket, call: string, args: z.infer<typeof jsonSchema>) {
  const id = crypto.randomUUID();
  // SAFETY: Wrangler's WebSocket proxy exposes the standard message event interface.
  const events = socket as { addEventListener(type: "message", handler: (event: { data: string }) => void): void;
    removeEventListener(type: "message", handler: (event: { data: string }) => void): void };
  const result = new Promise<z.infer<typeof rpcSchema>>((resolve, reject) => {
    const timer = setTimeout(() => { events.removeEventListener("message", message); reject(new Error(`RPC timed out: ${call}`)); }, 15000);
    function message(event: { data: string }) {
      const data = z.string().safeParse(event.data);
      if (!data.success) return;
      const frame = rpcSchema.safeParse(JSON.parse(data.data));
      if (!frame.success || frame.data.id !== id) return;
      clearTimeout(timer);
      events.removeEventListener("message", message);
      resolve(frame.data);
    }
    events.addEventListener("message", message);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return result;
}
