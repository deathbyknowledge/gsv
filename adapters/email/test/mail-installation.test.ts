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

function chunkedBody(bytes: Uint8Array, chunkBytes: number) {
  let offset = 0;
  return {
    length: bytes.byteLength,
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkBytes, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
  };
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

async function interruptAfterFirstChunk(
  stub: DurableObjectStub<MailInstallation>,
  installationId: string,
  bytes: Uint8Array,
): Promise<string> {
  return await runInDurableObject(stub, async (instance, state) => {
    const internals = instance as unknown as {
      storeRawMessage(intakeId: string, raw: Uint8Array): void;
    };
    const original = internals.storeRawMessage.bind(instance);
    internals.storeRawMessage = (intakeId, rawBytes) => {
      const first = rawBytes.slice(0, 1024 * 1024);
      state.storage.sql.exec(
        `INSERT INTO mail_intake_chunks (intake_id, chunk_index, content)
         VALUES (?, 0, ?)`,
        intakeId,
        first.buffer,
      );
      throw new Error("simulated intake interruption");
    };
    try {
      await (instance as MailInstallation).intake(
        context(installationId),
        {
          from: "mike@example.com",
          to: "hank@gsv.space",
          rawSize: bytes.byteLength,
        },
        bodyFromBytes(bytes),
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      internals.storeRawMessage = original;
    }
    return "";
  });
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

  it("resumes an interrupted multi-transaction intake from bounded chunks", async () => {
    const installationId = "installation_mail_chunked_retry";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const bytes = encoder.encode(
      `Subject: retry storage\r\n\r\n${"x".repeat(2_200_000)}`,
    );
    await expect(interruptAfterFirstChunk(stub, installationId, bytes))
      .resolves.toContain("simulated intake interruption");
    const staged = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{
        uploads: number;
        intakes: number;
        chunks: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM mail_intake_uploads) AS uploads,
           (SELECT COUNT(*) FROM mail_intakes) AS intakes,
           (SELECT COUNT(*) FROM mail_intake_chunks) AS chunks`,
      ).one());
    expect(staged).toEqual({ uploads: 1, intakes: 0, chunks: 1 });

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

  it("durably stages a message at the configured 16 MiB boundary", async () => {
    const installationId = "installation_mail_size_boundary";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as {
        limits: { dailyInboundBytes: number };
      };
      internals.limits.dailyInboundBytes = 64 * 1024 * 1024;
    });
    const bytes = new Uint8Array(16 * 1024 * 1024 - 1);
    const prefix = encoder.encode("Subject: size boundary\r\n\r\n");
    bytes.set(prefix);
    bytes.fill("x".charCodeAt(0), prefix.byteLength);

    const result = await stub.intake(
      context(installationId),
      {
        from: "mike@example.com",
        to: "hank@gsv.space",
        rawSize: bytes.byteLength,
      },
      chunkedBody(bytes, 1024 * 1024),
    );

    expect(result).toMatchObject({ status: "accepted" });
    const durable = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{
        raw_size: number;
        chunks: number;
        stored_bytes: number;
      }>(
        `SELECT raw_size,
                (SELECT COUNT(*) FROM mail_intake_chunks
                 WHERE mail_intake_chunks.intake_id = mail_intakes.intake_id) AS chunks,
                (SELECT SUM(length(content)) FROM mail_intake_chunks
                 WHERE mail_intake_chunks.intake_id = mail_intakes.intake_id) AS stored_bytes
         FROM mail_intakes`,
      ).one());
    expect(durable).toEqual({
      raw_size: bytes.byteLength,
      chunks: 16,
      stored_bytes: bytes.byteLength,
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.getIntake(
      context(installationId),
      result.status === "accepted" ? result.intakeId : "",
    )).resolves.toMatchObject({
      storageState: "stored",
      summaryState: "complete",
    });
  });

  it("reclaims expired partial intake chunks and quota reservations", async () => {
    const installationId = "installation_mail_partial_cleanup";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const bytes = encoder.encode(
      `Subject: abandoned intake\r\n\r\n${"x".repeat(1_200_000)}`,
    );
    await interruptAfterFirstChunk(stub, installationId, bytes);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE mail_intake_uploads SET expires_at = ?",
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const remaining = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{
        uploads: number;
        chunks: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM mail_intake_uploads) AS uploads,
           (SELECT COUNT(*) FROM mail_intake_chunks) AS chunks`,
      ).one());
    expect(remaining).toEqual({ uploads: 0, chunks: 0 });
    await expect(stub.usage()).resolves.toMatchObject({
      inboundMessages: 0,
      inboundBytes: 0,
    });
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

  it.each(["retry summary", "invalid summary"])(
    "advances the durable inference key after a terminal %s failure",
    async (subject) => {
      const installationId = `installation_mail_${subject.replace(" ", "_")}`;
      const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
      const accepted = await intake(stub, installationId, subject);
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
        summaryState: "pending",
        summaryAttempts: 1,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE mail_daily_usage SET summarization_attempts = 0",
        );
        state.storage.sql.exec(
          `UPDATE mail_intakes
           SET summary_next_attempt_at = ?
           WHERE intake_id = ?`,
          Date.now(),
          intakeId,
        );
        await state.storage.setAlarm(Date.now() + 60_000);
      });

      await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
      await expect(stub.getIntake(
        context(installationId),
        intakeId,
      )).resolves.toMatchObject({
        summaryState: "complete",
        summaryAttempts: 2,
        completionAttempts: 1,
      });
      const generation = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ summary_generation: number }>(
          `SELECT summary_generation
           FROM mail_intakes
           WHERE intake_id = ?`,
          intakeId,
        ).one().summary_generation);
      expect(generation).toBe(2);
    },
  );

  it("recovers a completed inference result after its RPC response is lost", async () => {
    const installationId = "installation_mail_lost_summary_response";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const accepted = await intake(stub, installationId, "lost summary response");
    if (accepted.result.status !== "accepted") {
      throw new Error("test mail was not accepted");
    }
    const intakeId = accepted.result.intakeId;

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(stub.getIntake(
      context(installationId),
      intakeId,
    )).resolves.toMatchObject({
      summaryState: "complete",
      summaryAttempts: 1,
      completionAttempts: 1,
    });
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

  it("isolates a corrupt retry row so later mail still completes", async () => {
    const installationId = "installation_mail_corrupt_retry";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const corrupt = await intake(stub, installationId, "corrupt retry");
    const healthy = await intake(stub, installationId, "healthy after corrupt");
    if (
      corrupt.result.status !== "accepted"
      || healthy.result.status !== "accepted"
    ) {
      throw new Error("test mail was not accepted");
    }
    const corruptId = corrupt.result.intakeId;
    const healthyId = healthy.result.intakeId;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM mail_intake_chunks WHERE intake_id = ? AND chunk_index = 0",
        corruptId,
      );
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(stub.getIntake(
      context(installationId),
      corruptId,
    )).resolves.toMatchObject({
      storageState: "pending",
      storageAttempts: 1,
    });
    await expect(stub.getIntake(
      context(installationId),
      healthyId,
    )).resolves.toMatchObject({
      storageState: "stored",
      summaryState: "complete",
    });
    const nextAlarm = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(nextAlarm).toBeGreaterThan(Date.now());
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
