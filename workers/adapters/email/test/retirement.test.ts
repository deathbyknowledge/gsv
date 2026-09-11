import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";
import { describe, expect, it } from "vitest";
import { MAIL_OWNED_TABLES } from "../src/retirement";
import { MailInstallation } from "../src/mail-installation";
import type { MailEnv } from "../src/env";

function bytes() { return new TextEncoder().encode("From: person@example.com\r\nTo: hank@gsv.space\r\nSubject: retirement fixture\r\nContent-Type: text/plain\r\n\r\nFixture body"); }
async function populate(id: string) {
  const stub = mailEnv.MAIL_INSTALLATIONS.getByName(id);
  const raw = bytes();
  await stub.intake({ installationId: id }, { from: "person@example.com", to: "hank@gsv.space", rawSize: raw.length }, bodyFromBytes(raw));
  return stub;
}
function request(id: string): InstallationDeletionRequest { return { version: 1, installationId: id, operationId: `delete:${id}` }; }
// SAFETY: Wrangler test bindings implement the actual mail service contracts.
const runtimeBindings: unknown = env;
// SAFETY: the configured test service bindings implement this structural RPC environment.
const mailEnv = runtimeBindings as MailEnv;

describe("mail installation retirement", () => {
  it("recognizes exact runtime identity metadata while rejecting unknown application tables", async () => {
    const id = "installation_runtime_metadata";
    const stub = mailEnv.MAIL_INSTALLATIONS.getByName(id);
    await runInDurableObject(stub, async (value, state) => {
      // SAFETY: MAIL_INSTALLATIONS binds the MailInstallation class in Wrangler.
      const instance = value as MailInstallation;
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS __miniflare_do_name (name TEXT)");
      expect(await instance.inspectInstallationResource()).toMatchObject({ understood: true });
      state.storage.sql.exec("CREATE TABLE __miniflare_application_data (value TEXT)");
      expect(await instance.inspectInstallationResource()).toMatchObject({ understood: false });
      expect(await instance.eraseInstallation(request(id))).toMatchObject({ outcome: "missing-inventory" });
      state.storage.sql.exec("DROP TABLE __miniflare_application_data");
      expect(await instance.eraseInstallation(request(id))).toMatchObject({ phase: "live-erased", pendingResources: 0 });
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = '__miniflare_do_name'").toArray()).toHaveLength(1);
    });
  });

  it("erases every owned row, retains a fence and preserves another space", async () => {
    const id = "installation_retirement";
    const stub = await populate(id);
    const other = await populate("installation_preserved");
    const input = request(id);
    expect(await stub.quiesceInstallation(input)).toMatchObject({ phase: "quiesced" });
    expect(await stub.eraseInstallation(input)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending", retainedCopies: [{ kind: "backup" }] });
    expect(await stub.eraseInstallation(input)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    await runInDurableObject(stub, async (value, state) => {
      // SAFETY: MAIL_INSTALLATIONS binds the MailInstallation class in Wrangler.
      const instance = value as MailInstallation;
      for (const table of MAIL_OWNED_TABLES) expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT * FROM mail_retirement").toArray()).toHaveLength(1);
      expect(() => state.storage.sql.exec("INSERT INTO mail_daily_usage(day) VALUES ('2026-09-11')")).toThrow("retired");
      const reconstructed = new MailInstallation(state, mailEnv);
      await expect(reconstructed.intake({ installationId: id }, { from: "a@example.com", to: "b@example.com", rawSize: 1 }, bodyFromBytes(new Uint8Array([1])))).rejects.toThrow("retired");
      await reconstructed.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      await expect(instance.eraseInstallation({ ...input, operationId: "another-operation" })).rejects.toThrow("immutable");
    });
    expect((await other.usage()).inboundMessages).toBe(1);
  });

  it("cancels an intake body while quiescing and never recreates its payload", async () => {
    const id = "installation_stalled_intake";
    const stub = mailEnv.MAIL_INSTALLATIONS.getByName(id);
    await runInDurableObject(stub, async (value, state) => {
      // SAFETY: MAIL_INSTALLATIONS binds the MailInstallation class in Wrangler.
      const instance = value as MailInstallation;
      let cancelled = false;
      const pending = instance.intake({ installationId: id }, { from: "a@example.com", to: "b@example.com", rawSize: 3 }, {
        length: 3, stream: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
      });
      const failure = expect(pending).rejects.toThrow("retired");
      const first = await instance.quiesceInstallation(request(id));
      expect(["quiescing", "quiesced"]).toContain(first.phase);
      await failure;
      expect(cancelled).toBe(true);
      expect(await instance.eraseInstallation(request(id))).toMatchObject({ phase: "live-erased", pendingResources: 0 });
      expect(state.storage.sql.exec("SELECT * FROM mail_intake_chunks").toArray()).toHaveLength(0);
    });
  });

  it("does not claim quiescence while a summary is running and ignores its late result", async () => {
    const id = "installation_stalled_summary";
    const stub = await populate(id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE mail_intakes SET storage_state = 'stored', metadata_json = NULL, message_id = 'message_fixture', stored_at = ?, summary_next_attempt_at = ?", Date.now(), Date.now());
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      let completions = 0;
      const instance = new MailInstallation(state, { ...mailEnv,
        INFERENCE: { summarizeMail: async () => { started(); await gate; return { summary: "late fixture", category: "personal", requiresAttention: false, confidence: 1 }; }, getMailSummaryStatus: async () => ({ state: "missing" }) },
        GATEWAY: { ...mailEnv.GATEWAY, completeInboundMail: async () => { completions++; } },
      });
      const running = instance.alarm();
      await entered;
      expect(await instance.quiesceInstallation(request(id))).toMatchObject({ phase: "quiescing" });
      release();
      await running;
      expect(await instance.quiesceInstallation(request(id))).toMatchObject({ phase: "quiesced" });
      expect(completions).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec<{ summary_json: string | null }>("SELECT summary_json FROM mail_intakes").one().summary_json).toBeNull();
    });
  });
  it("bounds each erase call and resumes from persisted state without extending backup retention", async () => {
    const id = "installation_bounded_retirement";
    const stub = mailEnv.MAIL_INSTALLATIONS.getByName(id);
    await runInDurableObject(stub, async (_instance, state) => {
      for (let i = 0; i < 620; i++) state.storage.sql.exec("INSERT INTO mail_daily_usage(day) VALUES (?)", `fixture:${i}`);
      const instance = new MailInstallation(state, mailEnv);
      const first = await instance.eraseInstallation(request(id));
      expect(first).toMatchObject({ phase: "erasing", pendingResources: 121 });
      const resumed = new MailInstallation(state, mailEnv);
      const complete = await resumed.eraseInstallation(request(id));
      expect(complete).toMatchObject({ phase: "live-erased", pendingResources: 0 });
      expect((await resumed.eraseInstallation(request(id))).retainedCopies).toEqual(complete.retainedCopies);
    });
  });

  it("awaits an admitted provider send and suppresses its late completion", async () => {
    const id = "installation_outbound_retirement";
    const stub = mailEnv.MAIL_INSTALLATIONS.getByName(id);
    await runInDurableObject(stub, async (_instance, state) => {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      let completions = 0;
      let sends = 0;
      const instance = new MailInstallation(state, { ...mailEnv,
        EMAIL: { send: async () => { sends++; started(); await gate; return { messageId: "provider_retirement" }; } },
        GATEWAY: {
          acceptInboundMail: (...args) => mailEnv.GATEWAY.acceptInboundMail(...args),
          completeInboundMail: (...args) => mailEnv.GATEWAY.completeInboundMail(...args),
          claimOutboundMail: (...args) => mailEnv.GATEWAY.claimOutboundMail(...args),
          completeOutboundMail: async () => { completions++; },
        },
      });
      const ref = { version: 1 as const, outboundId: "outbound-retirement", fingerprint: `sha256:${"a".repeat(64)}` };
      const pending = instance.deliverOutbound({ installationId: id }, ref);
      await entered;
      expect(await instance.quiesceInstallation(request(id))).toMatchObject({ phase: "quiescing" });
      release();
      await pending;
      expect(await instance.quiesceInstallation(request(id))).toMatchObject({ phase: "quiesced" });
      await instance.deliverOutbound({ installationId: id }, ref);
      await instance.alarm();
      expect(sends).toBe(1);
      expect(completions).toBe(0);
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM mail_outbound_deliveries").one().state).toBe("attempting");
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

});
