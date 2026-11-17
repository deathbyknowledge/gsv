import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  AdapterInstallationContext,
  ManagedOutboundMailClaimOutcome,
  ManagedOutboundMailDraft,
  ManagedOutboundMailReference,
} from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryResult, InstallationState } from "@humansandmachines/gsv/services/directory";
import PostalMime, { type Email } from "postal-mime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailPolicy } from "../src/policy";
import type { MailEnv } from "../src/env";
import { handleOutboundCommand } from "../src/index";
import { MailInstallation } from "../src/mail-installation";
import type { SentMail } from "../src/sending";

type OutboundPayload = {
  draft: {
    from: string;
    to: string;
    subject: string;
    textSize: number;
  };
  recipients: string[];
  mime: string;
};

type OutboundInternals = {
  policy: MailPolicy;
  outbound: {
    send(outbound: OutboundPayload): Promise<SentMail>;
  };
};

type SendRawBody = { from: string; recipients: string[]; mime_message: string };
type SendRawRequest = { url: string; authorization: string | null; body: SendRawBody };

afterEach(() => {
  vi.unstubAllGlobals();
});

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

/** What Email Sending reports for a message every recipient got. */
function sent(messageId: string, delivered = ["recipient@example.com"]): SentMail {
  return { messageId, delivered, queued: [], permanentBounces: [], suppressed: [] };
}

/** Email Sending's answer to a send_raw request it took. */
function sendingAnswer(result: {
  message_id?: string;
  delivered?: string[];
  queued?: string[];
  permanent_bounces?: string[];
  suppressed_recipients?: string[];
}): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: { delivered: [], queued: [], permanent_bounces: [], ...result },
  });
}

/** Email Sending's answer to a send_raw request it refused. */
function sendingError(status: number, code: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status, headers: { "cf-ray": "8f0e1d2c3b4a5968-LHR" } },
  );
}

/** The send_raw request one stubbed fetch call carried. */
function sendRawRequest(call: [RequestInfo | URL, RequestInit?]): SendRawRequest {
  const [input, init] = call;
  // SAFETY: the Worker posts a JSON send_raw body; the assertions check its fields.
  const body = JSON.parse(String(init?.body)) as SendRawBody;
  return { url: String(input), authorization: new Headers(init?.headers).get("authorization"), body };
}

async function sentMessage(call: [RequestInfo | URL, RequestInit?]): Promise<Email> {
  return await PostalMime.parse(sendRawRequest(call).body.mime_message);
}

/** A part's text as written: PostalMime keeps the line break that belongs to the next boundary. */
function partText(text: string | undefined): string | undefined {
  return text?.replace(/\n$/, "");
}

async function withSend(
  stub: DurableObjectStub<MailInstallation>,
  operation: (
    instance: MailInstallation,
    state: DurableObjectState,
    calls: OutboundPayload[],
  ) => Promise<void>,
  send?: (outbound: OutboundPayload) => Promise<SentMail>,
): Promise<OutboundPayload[]> {
  return await runInDurableObject(stub, async (instance, state) => {
    const calls: OutboundPayload[] = [];
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
    const untyped: unknown = instance;
    // SAFETY: The test fixture exposes the concrete outbound internals.
    const internals = untyped as OutboundInternals;
    const original = internals.outbound.send.bind(internals.outbound);
    internals.outbound.send = async (outbound) => {
      calls.push(outbound);
      return send
        ? await send(outbound)
        : sent(`provider_${calls.length}`);
    };
    try {
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
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

function outboundAdmissionFixture(installationId: string, state: InstallationState) {
  // SAFETY: Wrangler's test Workers implement the configured Mail service contracts.
  const configured = env as typeof env & MailEnv;
  const active = { found: true, installationId, handle: "hank", canonicalOrigin: "https://hank.gsv.space", state: "active" } satisfies InstallationDirectoryResult;
  const resolveInstallation = vi.fn(async (): Promise<InstallationDirectoryResult> => ({ ...active, state }));
  const send = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => sendingAnswer({
    message_id: "provider_resumed",
    // SAFETY: the Worker posts a JSON send_raw body.
    delivered: (JSON.parse(String(init?.body)) as SendRawBody).recipients,
  }));
  vi.stubGlobal("fetch", send);
  const claimOutboundMail = vi.fn<MailEnv["GATEWAY"]["claimOutboundMail"]>((...args) => configured.GATEWAY.claimOutboundMail(...args));
  const completeOutboundMail = vi.fn<MailEnv["GATEWAY"]["completeOutboundMail"]>((...args) => configured.GATEWAY.completeOutboundMail(...args));
  const bindings: MailEnv = {
    ...configured,
    ACCOUNTS: { resolveHostname: (...args) => configured.ACCOUNTS.resolveHostname(...args), resolveInstallation },
    GATEWAY: {
      acceptInboundMail: (...args) => configured.GATEWAY.acceptInboundMail(...args),
      completeInboundMail: (...args) => configured.GATEWAY.completeInboundMail(...args),
      resolveOutboundMailReference: (...args) => configured.GATEWAY.resolveOutboundMailReference(...args),
      claimOutboundMail,
      completeOutboundMail,
    },
  };
  return { bindings, resolveInstallation, send, claimOutboundMail, completeOutboundMail, active };
}

describe("managed outbound mail delivery", () => {
  it.each([
    { from: "hank@gsv.space", aliases: ["gsv.space"], state: "accepted" },
    { from: "hank@ship.space", aliases: ["gsv.space"], state: "accepted" },
    { from: "attacker@gsv.space", aliases: ["gsv.space"], state: "failed" },
    { from: "hank@untrusted.example", aliases: ["gsv.space"], state: "failed" },
    { from: "hank@gsv.space", aliases: [], state: "failed" },
  ])("validates $from against the owner's configured sending domains $aliases", async ({ from, aliases, state: expected }) => {
    const installationId = `installation_outbound_alias_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    fixture.bindings.MAIL_DOMAIN = "ship.space";
    fixture.bindings.MAIL_SENDING_DOMAINS = JSON.stringify(aliases);
    fixture.bindings.MAIL_RECEIVING_DOMAINS = JSON.stringify(["ship.space", "gsv.space"]);
    const originalClaim = fixture.claimOutboundMail.getMockImplementation()!;
    fixture.claimOutboundMail.mockImplementation(async (...args) => {
      const claim = await originalClaim(...args);
      if (claim.status === "ready") claim.draft.from = from;
      return claim;
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const instance = new MailInstallation(state, fixture.bindings);
      const value = reference("outbound-domain-alias");
      await instance.deliverOutbound(context(installationId), value);
      await instance.deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: "hank@ship.space",
        state: expected,
        error_code: expected === "accepted" ? null : "invalid_draft",
        callback_completed_at: expect.any(Number),
      })]);
    });
    expect(fixture.send).toHaveBeenCalledTimes(expected === "accepted" ? 1 : 0);
    if (expected === "accepted") expect(sendRawRequest(fixture.send.mock.calls[0]).body.from).toBe(from);
  });

  it.each([
    { primary: "gsv.space", promoted: "ship.space", changedHandle: false },
    { primary: "gsv.space", promoted: "ship.space", changedHandle: true },
    { primary: "ship.space", promoted: "fleet.example", changedHandle: false },
  ])("rechecks the pinned owner from $primary to $promoted (handle changed: $changedHandle)", async ({ primary, promoted, changedHandle }) => {
    const installationId = `installation_outbound_alias_retry_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    fixture.bindings.MAIL_DOMAIN = primary;
    fixture.bindings.MAIL_SENDING_DOMAINS = JSON.stringify(["gsv.space"]);
    fixture.claimOutboundMail.mockRejectedValueOnce(new Error("temporary claim failure"));
    await runInDurableObject(stub, async (_instance, state) => {
      const value = reference("outbound-domain-alias-retry");
      const before = new MailInstallation(state, fixture.bindings);
      await before.deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: `hank@${primary}`, state: "claiming",
      })]);

      fixture.bindings.MAIL_DOMAIN = promoted;
      fixture.bindings.MAIL_SENDING_DOMAINS = JSON.stringify(["gsv.space"]);
      if (changedHandle) fixture.resolveInstallation.mockResolvedValue({ ...fixture.active, handle: "other" });
      state.storage.sql.exec(
        "UPDATE mail_outbound_deliveries SET claim_next_attempt_at = ?",
        Date.now(),
      );
      const after = new MailInstallation(state, fixture.bindings);
      await after.alarm();
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        expected_from: `hank@${primary}`,
        state: changedHandle ? "failed" : "accepted",
        error_code: changedHandle ? "sender_identity_changed" : null,
      })]);
    });
    expect(fixture.send).toHaveBeenCalledTimes(changedHandle ? 0 : 1);
  });

  it.each([[1, 2], [2, 1]] as const)("sends once when queue versions %i then %i reference the same immutable draft", async (first, second) => {
    const installationId = `installation_outbound_versions_${first}_${second}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const outboundId = `outbound-versions-${first}-${second}`;
    const calls = await withSend(stub, async () => {
      // SAFETY: Wrangler test service bindings implement these Mail RPC contracts.
      const queueEnv = env as typeof env & MailEnv;
      for (const version of [first, second]) {
        await handleOutboundCommand(version === 1
          ? { ...reference(outboundId), installationId }
          : { version: 2, installationId, outboundId }, queueEnv);
      }
    });

    expect(calls).toHaveLength(1);
    const rows = await runInDurableObject(stub, (_instance, state) => deliveryRows(state));
    expect(rows).toEqual([expect.objectContaining({
      outbound_id: outboundId,
      state: "accepted",
      provider_message_id: "provider_1",
      callback_attempts: 1,
    })]);
  });

  it("uses the trusted draft and accepts a successful send once", async () => {
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
      recipients: ["recipient@example.com"],
      mime: expect.any(String),
    }]);
    const message = await PostalMime.parse(calls[0].mime);
    expect(message).toMatchObject({
      from: { address: "hank@gsv.space" },
      to: [{ address: "recipient@example.com" }],
      subject: "Subject for outbound-success",
    });
    expect(partText(message.text)).toBe("Body for outbound-success\n");
    expect(message.html).toContain("<p>Body for outbound-success</p>");
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

    expect(await PostalMime.parse(calls[0].mime)).toMatchObject({
      inReplyTo: "<original@example.com>",
      references: "<older@example.com> <original@example.com>",
    });
  });

  it("persists disabled delivery without claiming or sending", async () => {
    const installationId = "installation_outbound_disabled";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
      const untyped: unknown = instance;
      // SAFETY: The test fixture exposes the concrete outbound internals.
      const policy = (untyped as OutboundInternals).policy;
      vi.spyOn(policy, "limits").mockResolvedValue({ ...await policy.limits(), outboundEnabled: false });
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
      outboundBytes: calls.reduce((total, call) => total + call.draft.textSize, 0),
    });
  });

  it("rejects byte quota before entering the provider", async () => {
    const installationId = "installation_outbound_byte_quota";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);

    const calls = await withSend(stub, async (instance, state) => {
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
      const untyped: unknown = instance;
      // SAFETY: The test fixture exposes the concrete outbound internals.
      const policy = (untyped as OutboundInternals).policy;
      vi.spyOn(policy, "limits").mockResolvedValue({ ...await policy.limits(), dailyOutboundBytes: 1 });
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
    let finishProvider!: (result: SentMail) => void;
    const providerResult = new Promise<SentMail>((resolve) => {
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

        finishProvider(sent("provider_active"));
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
    let finishProvider!: (result: SentMail) => void;
    const providerResult = new Promise<SentMail>((resolve) => {
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
        finishProvider(sent("provider_alarm_replay"));
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

  it.each(["restricted", "reserved", "provisioning", "trialing", "past_due", "cancelled"] as const)("resumes a %s claim after repeated pauses and owner reconstruction", async (status) => {
    const installationId = `installation_paused_${status}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, status);
    const value = reference(`outbound-paused-${status}`);

    await runInDurableObject(stub, async (_instance, state) => {
      let instance = new MailInstallation(state, fixture.bindings);
      await instance.deliverOutbound(context(installationId), value);
      for (let attempt = 1; attempt <= 8; attempt++) {
        expect(deliveryRows(state)).toEqual([expect.objectContaining({
          state: "claiming", error_code: "claim_unavailable", expected_from: null,
          claim_attempts: attempt, claim_next_attempt_at: expect.any(Number),
          callback_attempts: 0, callback_completed_at: null,
        })]);
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(fixture.claimOutboundMail).not.toHaveBeenCalled();
        expect(fixture.completeOutboundMail).not.toHaveBeenCalled();
        expect(fixture.send).not.toHaveBeenCalled();
        expect(state.storage.sql.exec("SELECT * FROM mail_daily_usage").toArray()).toEqual([]);
        state.storage.sql.exec("UPDATE mail_outbound_deliveries SET claim_next_attempt_at = ?", Date.now());
        instance = new MailInstallation(state, fixture.bindings);
        if (attempt < 8) await instance.alarm();
      }
      fixture.resolveInstallation.mockResolvedValue(fixture.active);
      await instance.alarm();
      await instance.deliverOutbound(context(installationId), value);
      await instance.alarm();
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "accepted", expected_from: "hank@gsv.space", claim_attempts: 9,
        claim_next_attempt_at: null, callback_completed_at: expect.any(Number),
      })]);
    });

    expect(fixture.claimOutboundMail).toHaveBeenCalledOnce();
    expect(fixture.completeOutboundMail).toHaveBeenCalledOnce();
    expect(fixture.send).toHaveBeenCalledOnce();
  });

  it.each(["retained", "deleting", "deleted"] as const)("settles a terminal %s installation without claiming or sending", async (status) => {
    const installationId = `installation_terminal_${status}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, status);
    const value = reference(`outbound-terminal-${status}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const instance = new MailInstallation(state, fixture.bindings);
      await instance.deliverOutbound(context(installationId), value);
      await instance.deliverOutbound(context(installationId), value);
      await instance.alarm();
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed", error_code: "installation_inactive", callback_completed_at: expect.any(Number),
      })]);
    });
    expect(fixture.claimOutboundMail).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.completeOutboundMail).toHaveBeenCalledOnce();
  });

  it("retries a mismatched terminal directory reply without settling another identity", async () => {
    const installationId = "installation_mismatched_terminal";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    fixture.resolveInstallation.mockResolvedValue({ ...fixture.active, installationId: "another-installation", state: "deleted" });
    await runInDurableObject(stub, async (_instance, state) => {
      const instance = new MailInstallation(state, fixture.bindings);
      await instance.deliverOutbound(context(installationId), reference("outbound-mismatched-terminal"));
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "claiming", error_code: "claim_unavailable" })]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(fixture.claimOutboundMail).not.toHaveBeenCalled();
    expect(fixture.completeOutboundMail).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("erases a paused claim and rejects its late replay after reconstruction", async () => {
    const installationId = "installation_retired_paused_claim";
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "restricted");
    const value = reference("outbound-retired-paused");
    const request = { version: 1 as const, installationId, operationId: "retire-paused-claim" };
    await runInDurableObject(stub, async (_instance, state) => {
      const instance = new MailInstallation(state, fixture.bindings);
      await instance.deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)[0].state).toBe("claiming");
      expect(await instance.quiesceInstallation(request)).toMatchObject({ phase: "quiesced" });
      expect(await instance.eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
      const restored = new MailInstallation(state, fixture.bindings);
      fixture.resolveInstallation.mockResolvedValue(fixture.active);
      await restored.deliverOutbound(context(installationId), value);
      await restored.alarm();
      expect(deliveryRows(state)).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(fixture.claimOutboundMail).not.toHaveBeenCalled();
    expect(fixture.completeOutboundMail).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
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
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
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

/** A ready claim as the Gateway hands it over; build it inside the claim, since its stream belongs to the reading object. */
async function readyClaim(
  value: ManagedOutboundMailReference,
  text: string,
  draft: Partial<ManagedOutboundMailDraft> = {},
): Promise<ManagedOutboundMailClaimOutcome> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    status: "ready",
    draft: {
      version: 1,
      outboundId: value.outboundId,
      fingerprint: value.fingerprint,
      from: "hank@gsv.space",
      to: "recipient@example.com",
      subject: "Friday",
      bodyDigest: `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      textSize: bytes.byteLength,
      createdAt: Date.now(),
      ...draft,
    },
    body: { length: bytes.byteLength, stream: new Blob([bytes]).stream() },
  };
}

describe("outbound mail presentation", () => {
  it("sends the owner's name, the rendered Markdown, the footer and the quoted original", async () => {
    const installationId = `installation_outbound_presented_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    fixture.bindings.MAIL_FOOTER_TEXT = "Sent from my Ship";
    fixture.bindings.MAIL_FOOTER_URL = "https://ship.space";
    const value = reference("outbound-presented");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(
      value,
      "Table for **4**, see [the booking](https://thefork.com/b/1).",
      {
        fromName: "Hank Hill",
        quote: {
          from: "Mike <mike@example.com>",
          sentAt: Date.UTC(2026, 10, 6, 13, 5),
          timeZone: "UTC",
          text: "Can you make Friday?",
        },
      },
    ));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "accepted", error_code: null })]);
    });

    expect(fixture.send).toHaveBeenCalledOnce();
    const message = await sentMessage(fixture.send.mock.calls[0]);
    expect(message).toMatchObject({
      from: { address: "hank@gsv.space", name: "Hank Hill" },
      to: [{ address: "recipient@example.com" }],
      subject: "Friday",
    });
    expect(partText(message.text)).toBe([
      "Table for 4, see the booking (https://thefork.com/b/1).",
      "",
      "Sent from my Ship (https://ship.space)",
      "",
      "On Fri, 6 Nov 2026 at 13:05, Mike <mike@example.com> wrote:",
      "",
      "> Can you make Friday?",
      "",
    ].join("\n"));
    expect(message.html).toContain("<strong>4</strong>");
  });

  it("sends a bare address and no footer when neither is configured", async () => {
    const installationId = `installation_outbound_plain_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-plain");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "See you then."));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
    });

    const message = await sentMessage(fixture.send.mock.calls[0]);
    expect(message.from).toEqual({ address: "hank@gsv.space", name: "" });
    expect(partText(message.text)).toBe("See you then.\n");
    expect(message.html).not.toContain("Sent from");
  });

  it("fails a draft whose quote can't be shown without sending it", async () => {
    const installationId = `installation_outbound_bad_quote_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-bad-quote");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Friday works.", {
      quote: { from: "Mike <mike@example.com>", sentAt: 1, timeZone: "Mars/Olympus_Mons", text: "Can you?" },
    }));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "failed", error_code: "invalid_draft" })]);
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("holds mail while the operator's footer is misconfigured, then sends it", async () => {
    const installationId = `installation_outbound_bad_footer_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    fixture.bindings.MAIL_FOOTER_URL = "https://ship.space";
    const value = reference("outbound-bad-footer");

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "claiming", error_code: "claim_unavailable" })]);
      expect(fixture.claimOutboundMail).not.toHaveBeenCalled();

      fixture.bindings.MAIL_FOOTER_TEXT = "Sent from my Ship";
      state.storage.sql.exec("UPDATE mail_outbound_deliveries SET claim_next_attempt_at = ?", Date.now());
      await new MailInstallation(state, fixture.bindings).alarm();
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "accepted" })]);
    });
    expect(fixture.send).toHaveBeenCalledOnce();
  });
});

describe("outbound mail recipients", () => {
  it("sends to every To and Cc recipient and counts each toward the daily allowance", async () => {
    const installationId = `installation_outbound_copies_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-copies");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Table for four.", {
      to: ["recipient@example.com"],
      cc: ["anna@example.com"],
    }));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "accepted", error_code: null })]);
    });

    const request = sendRawRequest(fixture.send.mock.calls[0]);
    expect(request.body.recipients).toEqual(["recipient@example.com", "anna@example.com"]);
    expect(await PostalMime.parse(request.body.mime_message)).toMatchObject({
      to: [{ address: "recipient@example.com" }],
      cc: [{ address: "anna@example.com" }],
    });
    await expect(stub.usage()).resolves.toMatchObject({ outboundMessages: 2 });
  });

  it("refuses a message that reaches more people than the day still allows", async () => {
    const installationId = `installation_outbound_copies_quota_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-copies-quota");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Party!", {
      to: ["recipient@example.com", "mike@example.com"],
      cc: ["anna@example.com"],
    }));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "failed", error_code: "outbound_quota" })]);
    });

    expect(fixture.send).not.toHaveBeenCalled();
    await expect(stub.usage()).resolves.toMatchObject({ outboundMessages: 0 });
  });

  it.each([
    { recipients: "no To recipient", draft: { to: [] } },
    { recipients: "a repeated address", draft: { to: ["recipient@example.com"], cc: ["Recipient@example.com"] } },
    { recipients: "more than ten people", draft: { to: ["recipient@example.com"], cc: Array.from({ length: 10 }, (_, index) => `guest${index}@example.com`) } },
    { recipients: "an invalid copy", draft: { cc: ["not an address"] } },
  ])("fails a draft with $recipients without sending it", async ({ draft }) => {
    const installationId = `installation_outbound_bad_recipients_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-bad-recipients");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Hi.", draft));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "failed", error_code: "invalid_draft" })]);
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });
});

describe("outbound mail sending", () => {
  it("sends the composed message through the operator's account with its token", async () => {
    const installationId = `installation_outbound_send_raw_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-send-raw");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Hi."));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "accepted",
        provider_message_id: "provider_resumed",
      })]);
    });

    expect(fixture.send).toHaveBeenCalledOnce();
    const request = sendRawRequest(fixture.send.mock.calls[0]);
    expect(request.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/email/sending/send_raw",
    );
    expect(request.authorization).toBe("Bearer test-email-sending-token");
    expect(request.body).toEqual({
      from: "hank@gsv.space",
      recipients: ["recipient@example.com"],
      mime_message: expect.stringMatching(/^From: hank@gsv\.space\r\n/),
    });
  });

  it("holds mail while the operator's sending credentials are missing, then sends it", async () => {
    const installationId = `installation_outbound_no_token_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    fixture.bindings.MAIL_SENDING_API_TOKEN = undefined;
    const value = reference("outbound-no-token");

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "claiming", error_code: "claim_unavailable" })]);
      expect(fixture.claimOutboundMail).not.toHaveBeenCalled();

      fixture.bindings.MAIL_SENDING_API_TOKEN = "test-email-sending-token";
      state.storage.sql.exec("UPDATE mail_outbound_deliveries SET claim_next_attempt_at = ?", Date.now());
      await new MailInstallation(state, fixture.bindings).alarm();
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "accepted" })]);
    });
    expect(fixture.send).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 400, code: 10001, errorCode: "provider_rejected" },
    { status: 400, code: 10202, errorCode: "provider_rejected" },
    { status: 401, code: 10101, errorCode: "sender_unavailable" },
    { status: 403, code: 10102, errorCode: "sender_unavailable" },
    { status: 403, code: 10203, errorCode: "sender_unavailable" },
    { status: 403, code: 10207, errorCode: "sender_unavailable" },
    { status: 404, code: 10000, errorCode: "sender_unavailable" },
  ])("fails a send Email Sending refused with $status $code, without counting it", async ({ status, code, errorCode }) => {
    const installationId = `installation_outbound_refused_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-refused");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Hi.", {
      to: ["recipient@example.com"],
      cc: ["anna@example.com"],
    }));
    fixture.completeOutboundMail.mockResolvedValue(undefined);
    fixture.send.mockImplementationOnce(async () => sendingError(status, code, "email.sending.error.refused"));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "failed",
        error_code: errorCode,
        callback_completed_at: expect.any(Number),
      })]);
    });

    expect(fixture.send).toHaveBeenCalledOnce();
    expect(fixture.completeOutboundMail).toHaveBeenCalledWith(
      context(installationId),
      expect.objectContaining({ state: "failed", errorCode }),
    );
    await expect(stub.usage()).resolves.toMatchObject({ outboundMessages: 0, outboundBytes: 0 });
  });

  it.each([
    {
      outcome: "every recipient bounced",
      result: { message_id: "provider_bounced", permanent_bounces: ["recipient@example.com", "anna@example.com"] },
      state: "failed", errorCode: "recipient_rejected", counted: 2,
    },
    {
      outcome: "every recipient was suppressed",
      result: { suppressed_recipients: ["recipient@example.com", "anna@example.com"] },
      state: "failed", errorCode: "recipient_suppressed", counted: 0,
    },
    {
      outcome: "one recipient got it",
      result: { message_id: "provider_partial", delivered: ["anna@example.com"], permanent_bounces: ["recipient@example.com"] },
      state: "accepted", errorCode: null, counted: 2,
    },
    {
      outcome: "delivery was queued",
      result: { message_id: "provider_queued", queued: ["recipient@example.com", "anna@example.com"] },
      state: "accepted", errorCode: null, counted: 2,
    },
  ])("settles a send where $outcome", async ({ result, state: expected, errorCode, counted }) => {
    const installationId = `installation_outbound_recipient_results_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-recipient-results");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Hi.", {
      to: ["recipient@example.com"],
      cc: ["anna@example.com"],
    }));
    fixture.completeOutboundMail.mockResolvedValue(undefined);
    fixture.send.mockImplementationOnce(async () => sendingAnswer(result));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: expected,
        error_code: errorCode,
        provider_message_id: expected === "accepted" ? result.message_id : null,
      })]);
    });

    expect(fixture.send).toHaveBeenCalledOnce();
    await expect(stub.usage()).resolves.toMatchObject({ outboundMessages: counted });
  });

  it.each([
    { error: "a server error", answer: () => sendingError(500, 10002, "email.sending.error.internal_server") },
    { error: "an unavailable service", answer: () => sendingError(503, 10100, "email.sending.error.authentication.upstream") },
    { error: "an unreadable answer", answer: () => new Response("<html>502</html>", { status: 200 }) },
    { error: "an answer without a message id", answer: () => sendingAnswer({ delivered: ["recipient@example.com"] }) },
    { error: "a dropped connection", answer: () => { throw new TypeError("Network connection lost."); } },
  ])("keeps a send that may have gone out ($error) unknown and counted", async ({ answer }) => {
    const installationId = `installation_outbound_maybe_sent_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-maybe-sent");
    fixture.claimOutboundMail.mockImplementation(() => readyClaim(value, "Hi."));
    fixture.completeOutboundMail.mockResolvedValue(undefined);
    fixture.send.mockImplementationOnce(async () => answer());

    await runInDurableObject(stub, async (_instance, state) => {
      const mail = new MailInstallation(state, fixture.bindings);
      await mail.deliverOutbound(context(installationId), value);
      await mail.deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "unknown",
        error_code: "delivery_outcome_unknown",
      })]);
    });

    expect(fixture.send).toHaveBeenCalledOnce();
    await expect(stub.usage()).resolves.toMatchObject({ outboundMessages: 1 });
  });

  it("retries a rate-limited send later and counts it once", async () => {
    const installationId = `installation_outbound_rate_limited_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-rate-limited");
    fixture.claimOutboundMail.mockImplementation(() => readyClaim(value, "Hi."));
    fixture.completeOutboundMail.mockResolvedValue(undefined);
    fixture.send.mockImplementationOnce(async () => sendingError(429, 10004, "email.sending.error.throttled"));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({
        state: "claiming",
        error_code: "provider_rate_limited",
        claim_next_attempt_at: expect.any(Number),
        callback_next_attempt_at: null,
      })]);
      expect(fixture.completeOutboundMail).not.toHaveBeenCalled();

      state.storage.sql.exec("UPDATE mail_outbound_deliveries SET claim_next_attempt_at = ?", Date.now());
      await new MailInstallation(state, fixture.bindings).alarm();
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "accepted", error_code: null })]);
    });

    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(fixture.completeOutboundMail).toHaveBeenCalledOnce();
    await expect(stub.usage()).resolves.toMatchObject({ outboundMessages: 1 });
  });

  it("records the provider's code for diagnosis without the recipient's address or the token", async () => {
    const installationId = `installation_outbound_refusal_telemetry_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    fixture.bindings.GSV_TELEMETRY_ENABLED = true;
    const value = reference("outbound-refusal-telemetry");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Hi."));
    fixture.completeOutboundMail.mockResolvedValue(undefined);
    fixture.send.mockImplementationOnce(async () => sendingError(400, 10001, "recipient@example.com is on the suppression list"));
    const records: unknown[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((record) => { records.push(record); });
    const warn = vi.spyOn(console, "warn").mockImplementation((record) => { records.push(record); });

    try {
      await runInDurableObject(stub, async (_instance, state) => {
        await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }

    expect(records).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        name: "mail.delivery.finished",
        properties: expect.objectContaining({
          outcome: "failed",
          reason: "provider_refused",
          errorCode: "10001",
          providerStatusCode: 400,
          providerRequestId: "8f0e1d2c3b4a5968-LHR",
        }),
      }),
    }));
    expect(JSON.stringify(records)).not.toContain("recipient@example.com");
    expect(JSON.stringify(records)).not.toContain("test-email-sending-token");
  });
});

const INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//GSV//cal//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:dinner@gsv.space",
  "DTSTAMP:20261111T120000Z",
  "DTSTART:20261127T201500Z",
  "DTEND:20261127T221500Z",
  "SUMMARY:Dinner",
  "ORGANIZER:mailto:hank@gsv.space",
  "ATTENDEE;RSVP=TRUE:mailto:recipient@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("outbound mail invites", () => {
  it("sends the invite a version 2 draft carries", async () => {
    const installationId = `installation_outbound_invite_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-invite");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Here is the invite.", {
      version: 2,
      invite: { method: "REQUEST", text: INVITE },
    }));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "accepted", error_code: null })]);
    });

    const request = sendRawRequest(fixture.send.mock.calls[0]);
    expect(request.body.mime_message).toContain("Content-Type: text/calendar; charset=UTF-8; method=REQUEST\r\n");
    const message = await PostalMime.parse(request.body.mime_message);
    expect(partText(message.text)).toBe("Here is the invite.\n");
    expect(message.attachments.map(({ mimeType, method }) => ({ mimeType, method }))).toEqual([
      { mimeType: "text/calendar", method: "REQUEST" },
      { mimeType: "application/ics", method: undefined },
    ]);
  });

  it.each([
    { problem: "an invite on a version 1 draft", draft: { invite: { method: "REQUEST" as const, text: INVITE } } },
    { problem: "a version 2 draft without an invite", draft: { version: 2 as const } },
    { problem: "an invite whose calendar has another method", draft: { version: 2 as const, invite: { method: "CANCEL" as const, text: INVITE } } },
    { problem: "an invite with bare line feeds", draft: { version: 2 as const, invite: { method: "REQUEST" as const, text: INVITE.replaceAll("\r\n", "\n") } } },
  ])("fails $problem without sending it", async ({ draft }) => {
    const installationId = `installation_outbound_bad_invite_${crypto.randomUUID()}`;
    const stub = env.MAIL_INSTALLATIONS.getByName(installationId);
    const fixture = outboundAdmissionFixture(installationId, "active");
    const value = reference("outbound-bad-invite");
    fixture.claimOutboundMail.mockImplementationOnce(() => readyClaim(value, "Here is the invite.", draft));

    await runInDurableObject(stub, async (_instance, state) => {
      await new MailInstallation(state, fixture.bindings).deliverOutbound(context(installationId), value);
      expect(deliveryRows(state)).toEqual([expect.objectContaining({ state: "failed", error_code: "invalid_draft" })]);
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
