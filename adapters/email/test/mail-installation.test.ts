import { env } from "cloudflare:workers";
import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  bodyFromBytes,
  type AdapterInstallationContext,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import type { MailInstallation } from "../src/mail-installation";

const encoder = new TextEncoder();

function raw(subject: string): Uint8Array {
  return encoder.encode([
    "From: Mike <mike@example.com>",
    "To: Hank <hank@gsv.space>",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body for ${subject}`,
  ].join("\r\n"));
}

function context(installationId: string): AdapterInstallationContext {
  return { installationId };
}

async function intake(
  stub: DurableObjectStub<MailInstallation>,
  installationId: string,
  subject: string,
) {
  const bytes = raw(subject);
  return await intakeBytes(stub, installationId, bytes);
}

async function intakeBytes(
  stub: DurableObjectStub<MailInstallation>,
  installationId: string,
  bytes: Uint8Array,
) {
  return {
    bytes,
    result: await stub.intake(
      context(installationId),
      {
        from: "mike@example.com",
        to: "hank@gsv.space",
        rawSize: bytes.byteLength,
      },
      bodyFromBytes(bytes),
    ),
  };
}

describe("managed mail installation transport", () => {
  it("deduplicates exact raw bytes without double-counting daily intake", async () => {
    const installationId = "installation_mail_dedupe";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const first = await intake(stub, installationId, "same");
    const replay = await intake(stub, installationId, "same");

    expect(first.result).toMatchObject({ status: "accepted" });
    expect(replay.result).toEqual({
      status: "duplicate",
      intakeId: first.result.status === "accepted" ? first.result.intakeId : "",
    });
    await expect(stub.usage()).resolves.toMatchObject({
      installationId,
      inboundMessages: 1,
      inboundBytes: first.bytes.byteLength,
      summarizationAttempts: 0,
    });
  });

  it("atomically enforces per-installation daily message quota", async () => {
    const installationId = "installation_mail_quota";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    await expect(intake(stub, installationId, "one")).resolves.toMatchObject({
      result: { status: "accepted" },
    });
    await expect(intake(stub, installationId, "two")).resolves.toMatchObject({
      result: { status: "accepted" },
    });
    await expect(intake(stub, installationId, "three")).resolves.toMatchObject({
      result: { status: "rejected", reason: "quota" },
    });
    await expect(stub.usage()).resolves.toMatchObject({
      inboundMessages: 2,
      summarizationAttempts: 0,
    });
  });

  it("atomically enforces per-installation daily byte quota", async () => {
    const installationId = "installation_mail_byte_quota";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const first = encoder.encode(
      `Subject: first large\r\n\r\n${"a".repeat(600 * 1024)}`,
    );
    const second = encoder.encode(
      `Subject: second large\r\n\r\n${"b".repeat(3 * 1024 * 1024)}`,
    );

    await expect(intakeBytes(stub, installationId, first)).resolves.toMatchObject({
      result: { status: "accepted" },
    });
    await expect(intakeBytes(stub, installationId, second)).resolves.toMatchObject({
      result: { status: "rejected", reason: "quota" },
    });
    await expect(stub.usage()).resolves.toMatchObject({
      inboundMessages: 1,
      inboundBytes: first.byteLength,
    });
  });

  it("persists retry bodies larger than one SQLite row as bounded chunks", async () => {
    const installationId = "installation_mail_chunked_retry";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const bytes = encoder.encode(
      `Subject: retry storage\r\n\r\n${"x".repeat(2_200_000)}`,
    );
    const accepted = await intakeBytes(stub, installationId, bytes);
    if (accepted.result.status !== "accepted") {
      throw new Error("test mail was not accepted");
    }
    const intakeId = accepted.result.intakeId;

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const chunks = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{
        chunk_count: number;
        largest_chunk: number;
        retained_size: number;
      }>(
        `SELECT COUNT(*) AS chunk_count,
                MAX(length(content)) AS largest_chunk,
                SUM(length(content)) AS retained_size
         FROM mail_intake_chunks
         WHERE intake_id = ?`,
        intakeId,
      ).one());
    expect(chunks.chunk_count).toBeGreaterThan(2);
    expect(chunks.largest_chunk).toBeLessThanOrEqual(1024 * 1024);
    expect(chunks.retained_size).toBe(bytes.byteLength);
  });

  it("stores raw through Gateway before summarizing and compacts the outbox", async () => {
    const installationId = "installation_mail_pipeline";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const accepted = await intake(stub, installationId, "pipeline");
    if (accepted.result.status !== "accepted") {
      throw new Error("test mail was not accepted");
    }
    const intakeId = accepted.result.intakeId;

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(stub.getIntake(
      context(installationId),
      intakeId,
    )).resolves.toMatchObject({
      storageState: "stored",
      summaryState: "complete",
      storageAttempts: 1,
      summaryAttempts: 1,
      completionAttempts: 1,
      messageId: `message_${intakeId}`,
    });
    const compacted = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{
        metadata_json: string | null;
        summary_input_json: string | null;
        summary_json: string | null;
        raw_chunks: number;
      }>(
        `SELECT metadata_json, summary_input_json, summary_json,
                (SELECT COUNT(*) FROM mail_intake_chunks
                 WHERE mail_intake_chunks.intake_id = mail_intakes.intake_id) AS raw_chunks
         FROM mail_intakes
         WHERE intake_id = ?`,
        intakeId,
      ).one());
    expect(compacted).toEqual({
      metadata_json: null,
      summary_input_json: null,
      summary_json: null,
      raw_chunks: 0,
    });
  });

  it("delivers mail immediately but explicitly defers excess summaries", async () => {
    const installationId = "installation_mail_summary_quota";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    await intake(stub, installationId, "first summary");
    await intake(stub, installationId, "second summary");

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const page = await stub.listIntakes(context(installationId), { limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.storageState === "stored")).toBe(true);
    expect(page.items.map((item) => item.summaryState).sort()).toEqual([
      "complete",
      "deferred",
    ]);
    await expect(stub.usage()).resolves.toMatchObject({
      inboundMessages: 2,
      summarizationAttempts: 1,
    });
    const nextAlarm = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(nextAlarm).toBeGreaterThan(Date.now());
  });

  it("retains exact raw for an alarm retry after Gateway failure", async () => {
    const installationId = "installation_mail_gateway_retry";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const accepted = await intake(stub, installationId, "retry storage");
    if (accepted.result.status !== "accepted") {
      throw new Error("test mail was not accepted");
    }
    const intakeId = accepted.result.intakeId;

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.getIntake(context(installationId), intakeId)).resolves.toMatchObject({
      storageState: "pending",
      storageAttempts: 1,
      summaryAttempts: 0,
    });
    const retainedBytes = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ raw_size: number; retained_size: number }>(
        `SELECT mail_intakes.raw_size,
                SUM(length(mail_intake_chunks.content)) AS retained_size
         FROM mail_intakes
         JOIN mail_intake_chunks USING (intake_id)
         WHERE mail_intakes.intake_id = ?
         GROUP BY mail_intakes.intake_id`,
        intakeId,
      ).one());
    expect(retainedBytes).toEqual({
      raw_size: accepted.bytes.byteLength,
      retained_size: accepted.bytes.byteLength,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE mail_intakes
         SET storage_next_attempt_at = ?
         WHERE intake_id = ?`,
        Date.now(),
        intakeId,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.getIntake(context(installationId), intakeId)).resolves.toMatchObject({
      storageState: "stored",
      summaryState: "complete",
      storageAttempts: 2,
      summaryAttempts: 1,
    });
  });

  it("rejects a caller context that does not own the named object", async () => {
    const stub = env.MAIL_INSTALLATIONS.getByName("installation_mail_owner");
    const bytes = raw("wrong owner");

    const rejection = await runInDurableObject(stub, async (instance) => {
      try {
        await (instance as MailInstallation).intake(
          context("installation_mail_other"),
          {
            from: "mike@example.com",
            to: "hank@gsv.space",
            rawSize: bytes.byteLength,
          },
          bodyFromBytes(bytes),
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    });
    expect(rejection).toContain("belongs to another installation");
    await expect(stub.usage()).resolves.toMatchObject({ inboundMessages: 0 });
  });
});
