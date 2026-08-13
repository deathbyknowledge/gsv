import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  AdapterInstallationContext,
  ManagedOutboundMailReference,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import type { MailInstallation } from "../src/mail-installation";

type OutboundPayload = {
  draft: {
    from: string;
    to: string;
    subject: string;
  };
  text: string;
  headers?: Record<string, string>;
};

type OutboundInternals = {
  limits: {
    outboundEnabled: boolean;
    dailyOutboundMessages: number;
    dailyOutboundBytes: number;
  };
  outbound: {
    send(outbound: OutboundPayload): Promise<EmailSendResult>;
  };
};

type DeliveryRow = {
  outbound_id: string;
  fingerprint: string;
  expected_from: string | null;
  state: string;
  text_size: number | null;
  provider_message_id: string | null;
  error_code: string | null;
  claim_attempts: number;
  claim_next_attempt_at: number | null;
  callback_attempts: number;
  callback_next_attempt_at: number | null;
  callback_completed_at: number | null;
};

function context(installationId: string): AdapterInstallationContext {
  return { installationId };
}

function reference(
  outboundId: string,
  marker = "a",
): ManagedOutboundMailReference {
  return {
    version: 1,
    outboundId,
    fingerprint: `sha256:${marker.repeat(64)}`,
  };
}

async function withSend(
  stub: DurableObjectStub<MailInstallation>,
  operation: (
    instance: MailInstallation,
    state: DurableObjectState,
    calls: OutboundPayload[],
  ) => Promise<void>,
  send?: (outbound: OutboundPayload) => Promise<EmailSendResult>,
): Promise<OutboundPayload[]> {
  return await runInDurableObject(stub, async (instance, state) => {
    const calls: OutboundPayload[] = [];
    const internals = instance as unknown as OutboundInternals;
    const original = internals.outbound.send.bind(internals.outbound);
    internals.outbound.send = async (outbound) => {
      calls.push(outbound);
      return send
        ? await send(outbound)
        : { messageId: `provider_${calls.length}` };
    };
    try {
      await operation(instance as MailInstallation, state, calls);
      return calls;
    } finally {
      internals.outbound.send = original;
    }
  });
}

function deliveryRows(state: DurableObjectState): DeliveryRow[] {
  return state.storage.sql.exec<DeliveryRow>(
    `SELECT outbound_id, fingerprint, expected_from, state, text_size,
            provider_message_id, error_code, claim_attempts,
            claim_next_attempt_at, callback_attempts,
            callback_next_attempt_at, callback_completed_at
     FROM mail_outbound_deliveries
     ORDER BY outbound_id, fingerprint`,
  ).toArray();
}

describe("managed outbound mail delivery", () => {
  it("uses the trusted draft and accepts a successful structured send once", async () => {
    const installationId = "installation_outbound_success";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const value = reference("outbound-success");

    const calls = await withSend(stub, async (instance) => {
      await instance.deliverOutbound(
        context(installationId),
        value,
      );
      await instance.deliverOutbound(
        context(installationId),
        value,
      );
    });

    expect(calls).toEqual([{
      draft: expect.objectContaining({
        from: "hank@gsv.space",
        to: "recipient@example.com",
        subject: "Subject for outbound-success",
      }),
      text: "Body for outbound-success",
    }]);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      deliveryRows(state));
    expect(rows).toEqual([expect.objectContaining({
      state: "accepted",
      provider_message_id: "provider_1",
      error_code: null,
      callback_attempts: 1,
      callback_next_attempt_at: null,
      callback_completed_at: expect.any(Number),
    })]);
  });

  it("maps trusted reply metadata to the allowed thread headers", async () => {
    const installationId = "installation_outbound_reply";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-reply"),
      );
    });

    expect(calls[0].headers).toEqual({
      "In-Reply-To": "<original@example.com>",
      References: "<older@example.com> <original@example.com>",
    });
  });

  it("persists disabled delivery without claiming or sending", async () => {
    const installationId = "installation_outbound_disabled";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      (instance as unknown as OutboundInternals).limits.outboundEnabled = false;
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-disabled"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        text_size: null,
        error_code: "outbound_disabled",
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("rejects a conflicting fingerprint without replaying the provider", async () => {
    const installationId = "installation_outbound_conflict";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-conflict", "a"),
      );
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-conflict", "b"),
      );
      expect(deliveryRows(state).map((row) => ({
        state: row.state,
        errorCode: row.error_code,
        callbackAttempts: row.callback_attempts,
        callbackCompleted: row.callback_completed_at !== null,
      }))).toEqual([
        {
          state: "accepted",
          errorCode: null,
          callbackAttempts: 1,
          callbackCompleted: true,
        },
        {
          state: "failed",
          errorCode: "fingerprint_conflict",
          callbackAttempts: 0,
          callbackCompleted: true,
        },
      ]);
    });

    expect(calls).toHaveLength(1);
  });

  it("transactionally reserves per-installation message quota", async () => {
    const installationId = "installation_outbound_message_quota";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      for (const id of ["outbound-one", "outbound-two", "outbound-three"]) {
        await instance.deliverOutbound(
          context(installationId),
          reference(id),
        );
      }
      expect(deliveryRows(state).map((row) => ({
        id: row.outbound_id,
        state: row.state,
        errorCode: row.error_code,
      }))).toEqual([
        { id: "outbound-one", state: "accepted", errorCode: null },
        { id: "outbound-three", state: "failed", errorCode: "outbound_quota" },
        { id: "outbound-two", state: "accepted", errorCode: null },
      ]);
    });

    expect(calls).toHaveLength(2);
    await expect(stub.usage()).resolves.toMatchObject({
      outboundMessages: 2,
      outboundBytes: calls.reduce(
        (total, call) => total + new TextEncoder().encode(call.text).byteLength,
        0,
      ),
    });
  });

  it("rejects byte quota before entering the provider", async () => {
    const installationId = "installation_outbound_byte_quota";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      (instance as unknown as OutboundInternals).limits.dailyOutboundBytes = 1;
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-byte-quota"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "outbound_quota",
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("marks a provider throw unknown and never sends that delivery again", async () => {
    const installationId = "installation_outbound_ambiguous";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const value = reference("outbound-ambiguous");

    const calls = await withSend(
      stub,
      async (instance, state) => {
        await instance.deliverOutbound(
          context(installationId),
          value,
        );
        await instance.deliverOutbound(
          context(installationId),
          value,
        );
        expect(deliveryRows(state)).toEqual([expect.objectContaining({
          state: "unknown",
          error_code: "delivery_outcome_unknown",
          callback_completed_at: expect.any(Number),
        })]);
      },
      async () => {
        throw new Error("simulated provider ambiguity");
      },
    );

    expect(calls).toHaveLength(1);
  });

  it("does not replay an attempting delivery recovered after restart", async () => {
    const installationId = "installation_outbound_restart";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const value = reference("outbound-restart");

    const calls = await withSend(stub, async (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO mail_outbound_deliveries (
           outbound_id, fingerprint, expected_from, state,
           attempting_expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'attempting', ?, ?, ?)`,
        value.outboundId,
        value.fingerprint,
        "hank@gsv.space",
        now + 60_000,
        now,
        now,
      );
      await instance.deliverOutbound(
        context(installationId),
        value,
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "unknown",
        error_code: "delivery_outcome_unknown",
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("does not expire a provider attempt that is still active in the isolate", async () => {
    const installationId = "installation_outbound_active_attempt";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let finishProvider!: (result: EmailSendResult) => void;
    const providerResult = new Promise<EmailSendResult>((resolve) => {
      finishProvider = resolve;
    });

    const calls = await withSend(
      stub,
      async (instance, state) => {
        const delivery = instance.deliverOutbound(
          context(installationId),
          reference("outbound-active-attempt"),
        );
        await started;
        const expiredAt = Date.now() - 1;
        state.storage.sql.exec(
          `UPDATE mail_outbound_deliveries
           SET attempting_expires_at = ?
           WHERE outbound_id = ?`,
          expiredAt,
          "outbound-active-attempt",
        );

        await instance.alarm();
        const active = deliveryRows(state)[0];
        expect(active).toMatchObject({ state: "attempting", error_code: null });
        expect(state.storage.sql.exec<{ attempting_expires_at: number }>(
          `SELECT attempting_expires_at
           FROM mail_outbound_deliveries
           WHERE outbound_id = ?`,
          "outbound-active-attempt",
        ).one().attempting_expires_at).toBeGreaterThan(expiredAt);

        finishProvider({ messageId: "provider_active" });
        await delivery;
        expect(deliveryRows(state)[0]).toMatchObject({
          state: "accepted",
          provider_message_id: "provider_active",
        });
      },
      async () => {
        providerStarted();
        return await providerResult;
      },
    );

    expect(calls).toHaveLength(1);
  });

  it("joins a Queue replay to an alarm-origin provider attempt", async () => {
    const installationId = "installation_outbound_alarm_replay";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const value = reference("outbound-alarm-replay");
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let finishProvider!: (result: EmailSendResult) => void;
    const providerResult = new Promise<EmailSendResult>((resolve) => {
      finishProvider = resolve;
    });

    const calls = await withSend(
      stub,
      async (instance, state) => {
        const now = Date.now();
        state.storage.sql.exec(
          `INSERT INTO mail_outbound_deliveries (
             outbound_id, fingerprint, expected_from, state,
             claim_next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, NULL, 'claiming', ?, ?, ?)`,
          value.outboundId,
          value.fingerprint,
          now,
          now,
          now,
        );

        const alarm = instance.alarm();
        await started;
        const replay = instance.deliverOutbound(context(installationId), value);
        finishProvider({ messageId: "provider_alarm_replay" });
        await Promise.all([alarm, replay]);

        expect(deliveryRows(state)).toEqual([expect.objectContaining({
          state: "accepted",
          provider_message_id: "provider_alarm_replay",
          error_code: null,
          callback_attempts: 1,
          callback_next_attempt_at: null,
          callback_completed_at: expect.any(Number),
        })]);
      },
      async () => {
        providerStarted();
        return await providerResult;
      },
    );

    expect(calls).toHaveLength(1);
  });

  it("retries a failed Gateway completion from the Durable Object alarm", async () => {
    const installationId = "installation_outbound_callback_retry";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-callback-retry"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "accepted",
        callback_attempts: 1,
        callback_completed_at: null,
        callback_next_attempt_at: expect.any(Number),
      })]);
      state.storage.sql.exec(
        "UPDATE mail_outbound_deliveries SET callback_next_attempt_at = ?",
        Date.now(),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(calls).toHaveLength(1);

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      deliveryRows(state));
    expect(rows).toEqual([expect.objectContaining({
      state: "accepted",
      callback_attempts: 2,
      callback_next_attempt_at: null,
      callback_completed_at: expect.any(Number),
    })]);
  });

  it("acks admission and retries a transient claim from the alarm exactly once", async () => {
    const installationId = "installation_outbound_claim_retry_once";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state, calls) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-claim-retry-once"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: "hank@gsv.space",
        state: "claiming",
        error_code: "claim_unavailable",
        claim_attempts: 1,
        claim_next_attempt_at: expect.any(Number),
      })]);
      expect(calls).toHaveLength(0);

      state.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET claim_next_attempt_at = ?
         WHERE outbound_id = ?`,
        Date.now(),
        "outbound-claim-retry-once",
      );
      await instance.alarm();

      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "accepted",
        error_code: null,
        claim_attempts: 2,
        claim_next_attempt_at: null,
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(1);
  });

  it("keeps repeated transient claim failures scheduled without calling EMAIL", async () => {
    const installationId = "installation_outbound_claim_always_fails";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-claim-always-fails"),
      );
      state.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET claim_next_attempt_at = ?
         WHERE outbound_id = ?`,
        Date.now(),
        "outbound-claim-always-fails",
      );
      await instance.alarm();

      const row = deliveryRows(state)[0];
      expect(row).toEqual(expect.objectContaining({
        expected_from: "hank@gsv.space",
        state: "claiming",
        error_code: "claim_unavailable",
        claim_attempts: 2,
        claim_next_attempt_at: expect.any(Number),
        callback_completed_at: null,
      }));
      expect(row.claim_next_attempt_at).toBeGreaterThan(Date.now());
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    expect(calls).toHaveLength(0);
  });

  it("recovers from an Accounts outage after the Queue retry window", async () => {
    const installationId = "installation_accounts-outage";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state, calls) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-accounts-outage"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: null,
        state: "claiming",
        error_code: "claim_unavailable",
        claim_attempts: 1,
      })]);

      for (let attempt = 2; attempt <= 13; attempt += 1) {
        state.storage.sql.exec(
          `UPDATE mail_outbound_deliveries
           SET claim_next_attempt_at = ?
           WHERE outbound_id = ?`,
          Date.now(),
          "outbound-accounts-outage",
        );
        await instance.alarm();
        if (attempt <= 12) expect(calls).toHaveLength(0);
      }

      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: "hank@gsv.space",
        state: "accepted",
        error_code: null,
        claim_attempts: 13,
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(1);
  });

  it("settles a pending claim when Accounts restricts the installation", async () => {
    const installationId = "installation_became-inactive";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-became-inactive"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "installation_inactive",
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("settles a missing installation and continues to later due claims", async () => {
    const installationId = "installation_missing-once";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const missing = reference("outbound-a-missing-installation");
    const later = reference("outbound-z-after-missing");

    const calls = await withSend(stub, async (instance, state) => {
      const now = Date.now();
      for (const [value, createdAt] of [
        [missing, now],
        [later, now + 1],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO mail_outbound_deliveries (
             outbound_id, fingerprint, expected_from, state,
             claim_next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, NULL, 'claiming', ?, ?, ?)`,
          value.outboundId,
          value.fingerprint,
          now,
          createdAt,
          now,
        );
      }

      await instance.alarm();

      expect(deliveryRows(state)).toEqual([
        expect.objectContaining({
          outbound_id: missing.outboundId,
          expected_from: null,
          state: "failed",
          error_code: "installation_inactive",
          callback_completed_at: expect.any(Number),
        }),
        expect.objectContaining({
          outbound_id: later.outboundId,
          expected_from: "hank@gsv.space",
          state: "accepted",
          error_code: null,
          callback_completed_at: expect.any(Number),
        }),
      ]);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].draft.subject).toBe("Subject for outbound-z-after-missing");
  });

  it("fails a pending claim when Accounts changes the sender handle", async () => {
    const installationId = "installation_changed-handle";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-changed-handle"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: "hank@gsv.space",
        state: "claiming",
        error_code: "claim_unavailable",
      })]);
      state.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET claim_next_attempt_at = ?
         WHERE outbound_id = ?`,
        Date.now(),
        "outbound-changed-handle",
      );
      await instance.alarm();
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: "hank@gsv.space",
        state: "failed",
        error_code: "sender_identity_changed",
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it.each([
    {
      outboundId: "outbound-gateway-body-unavailable",
      state: "failed",
      errorCode: "body_unavailable",
      providerMessageId: null,
    },
    {
      outboundId: "outbound-gateway-terminal-replay",
      state: "accepted",
      errorCode: null,
      providerMessageId: "provider_terminal",
    },
  ])("mirrors a terminal Gateway claim for $outboundId", async (expected) => {
    const installationId = `installation_${expected.outboundId.replaceAll("-", "_")}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const value = reference(expected.outboundId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(context(installationId), value);
      await instance.deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: expected.state,
        error_code: expected.errorCode,
        provider_message_id: expected.providerMessageId,
        callback_attempts: 0,
        callback_next_attempt_at: null,
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("fails a mismatched Gateway reference locally without a callback loop", async () => {
    const installationId = "installation_outbound_gateway_reference_mismatch";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const value = reference("outbound-gateway-reference-mismatch");

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(context(installationId), value);
      await instance.deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "reference_mismatch",
        callback_attempts: 0,
        callback_next_attempt_at: null,
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("does not let a failing claim starve a later completion callback", async () => {
    const installationId = "installation_outbound_claim_fairness";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-claim-always-fails-fairness"),
      );
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-callback-retry-after-claim"),
      );
      state.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET claim_next_attempt_at = ?
         WHERE state = 'claiming'`,
        Date.now(),
      );
      state.storage.sql.exec(
        `UPDATE mail_outbound_deliveries
         SET callback_next_attempt_at = ?
         WHERE state IN ('accepted', 'failed', 'unknown')
           AND callback_completed_at IS NULL`,
        Date.now(),
      );
      await instance.alarm();

      const rows = deliveryRows(state);
      expect(rows.find((row) => row.outbound_id.includes("callback-retry")))
        .toEqual(expect.objectContaining({
          state: "accepted",
          callback_attempts: 2,
          callback_next_attempt_at: null,
          callback_completed_at: expect.any(Number),
        }));
      expect(rows.find((row) => row.outbound_id.includes("always-fails")))
        .toEqual(expect.objectContaining({
          state: "claiming",
          claim_attempts: 2,
          claim_next_attempt_at: expect.any(Number),
        }));
    });

    expect(calls).toHaveLength(1);
  });

  it("persists malformed trusted drafts as terminal failures", async () => {
    const installationId = "installation_outbound_invalid";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-invalid"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "invalid_draft",
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("rejects a claimed sender that does not match the Accounts address", async () => {
    const installationId = "installation_outbound_sender_mismatch";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-sender-mismatch"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "invalid_draft",
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("rejects claimed body bytes that do not match their trusted digest", async () => {
    const installationId = "installation_outbound_body_corruption";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference("outbound-body-corruption"),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "invalid_draft",
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it.each([
    "outbound-oversized-address",
    "outbound-oversized-subject",
  ])("enforces UTF-8 draft bounds for %s", async (outboundId) => {
    const installationId = `installation_${outboundId.replaceAll("-", "_")}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
      await instance.deliverOutbound(
        context(installationId),
        reference(outboundId),
      );
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "invalid_draft",
      })]);
    });

    expect(calls).toHaveLength(0);
  });

  it("rejects a caller that does not own the named installation", async () => {
    const installationId = "installation_outbound_owner";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const error = await runInDurableObject(stub, async (instance, state) => {
      try {
        await (instance as MailInstallation).deliverOutbound(
          context("installation_outbound_other"),
          reference("outbound-owner"),
        );
      } catch (cause) {
        expect(deliveryRows(state)).toHaveLength(0);
        return cause instanceof Error ? cause.message : String(cause);
      }
      return "";
    });

    expect(error).toContain("belongs to another installation");
  });
});
