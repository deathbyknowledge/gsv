import { bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { ManagedOutboundMailReference } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryResult, InstallationState } from "@humansandmachines/gsv/services/directory";
import { describe, expect, it, vi } from "vitest";
import type { MailEnv } from "../src/env";
import {
  handleIncomingMail,
  handleOutboundBatch,
  handleOutboundCommand,
} from "../src/index";

function asMessageBatch<T>(value: T): MessageBatch {
  // SAFETY: Tests provide the message-batch fields consumed by the handler.
  return value as MessageBatch;
}

function asNamespace<T>(value: T): MailEnv["MAIL_INSTALLATIONS"] {
  // SAFETY: Tests provide the namespace method consumed by the handler.
  return value as MailEnv["MAIL_INSTALLATIONS"];
}

const encoder = new TextEncoder();

function environment(input: {
  directoryResult: Awaited<ReturnType<MailEnv["ACCOUNTS"]["resolveHostname"]>>;
  intake?: ReturnType<typeof vi.fn>;
}) {
  const resolveHostname = vi.fn(async () => input.directoryResult);
  const getByName = vi.fn(() => ({
    intake: input.intake ?? vi.fn(async () => ({
      status: "accepted",
      intakeId: "mail_test",
    })),
  }));
  return {
    env: {
      MAIL_DOMAIN: "gsv.space",
      GSV_BASE_DOMAIN: "gsv.space",
      MAIL_MAX_MESSAGE_BYTES: 16_777_216,
      MAIL_DAILY_INBOUND_MESSAGE_LIMIT: 250,
      MAIL_DAILY_INBOUND_BYTE_LIMIT: 268_435_456,
      MAIL_DAILY_SUMMARIZATION_LIMIT: 100,
      MAIL_OUTBOUND_ENABLED: 0,
      MAIL_MAX_OUTBOUND_TEXT_BYTES: 1_048_576,
      MAIL_DAILY_OUTBOUND_MESSAGE_LIMIT: 0,
      MAIL_DAILY_OUTBOUND_BYTE_LIMIT: 0,
      ACCOUNTS: {
        resolveHostname,
        resolveInstallation: vi.fn(async (): Promise<InstallationDirectoryResult> => ({
          found: false,
        })),
      },
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
      MAIL_INSTALLATIONS: asNamespace({ getByName }),
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
      GATEWAY: {} as MailEnv["GATEWAY"],
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
      INFERENCE: {} as MailEnv["INFERENCE"],
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
      EMAIL: {} as MailEnv["EMAIL"],
    },
    getByName,
    resolveHostname,
  };
}

function message(
  raw: Uint8Array,
  to = "hank@gsv.space",
): MessageFixture {
  const reject = vi.fn();
  const cancelled = vi.fn();
  let pullCount = 0;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        if (!sent) {
          sent = true;
          controller.enqueue(raw);
        }
        controller.close();
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  return {
    value: {
      from: "sender@example.com",
      to,
      headers: new Headers(),
      raw: stream,
      rawSize: raw.byteLength,
      setReject: reject,
      forward: vi.fn(),
      reply: vi.fn(),
    },
    reject,
    cancelled,
    pulls: () => pullCount,
  } satisfies MessageFixture;
}

type MessageFixture = {
  value: ForwardableEmailMessage;
  reject: ReturnType<typeof vi.fn>;
  cancelled: ReturnType<typeof vi.fn>;
  pulls: () => number;
};

describe("managed mail email handler", () => {
  it("resolves an active address before allocating its installation object", async () => {
    const raw = encoder.encode("Subject: hello\r\n\r\nbody");
    const incoming = message(raw);
    const intake = vi.fn(async (
      installation: { installationId: string },
      _envelope: Record<string, string> | null,
      body: Parameters<typeof bodyToBytes>[0],
    ) => {
      expect(installation).toEqual({ installationId: "installation_hank" });
      const byob = body.stream.getReader({ mode: "byob" });
      byob.releaseLock();
      expect(await bodyToBytes(body)).toEqual(raw);
      return { status: "accepted" as const, intakeId: "mail_test" };
    });
    const fixture = environment({
      directoryResult: {
        found: true,
        state: "active",
        installationId: "installation_hank",
        handle: "hank",
        canonicalOrigin: "https://hank.gsv.space",
      },
      intake,
    });

    await handleIncomingMail(incoming.value, fixture.env);

    expect(fixture.resolveHostname).toHaveBeenCalledWith("hank.gsv.space");
    expect(fixture.getByName).toHaveBeenCalledWith("installation_hank");
    expect(intake).toHaveBeenCalledOnce();
    expect(incoming.pulls()).toBe(1);
    expect(incoming.reject).not.toHaveBeenCalled();
  });

  it("rejects an unknown address without allocating Durable Object state", async () => {
    const incoming = message(encoder.encode("Subject: hello\r\n\r\nbody"));
    const fixture = environment({ directoryResult: { found: false } });

    await handleIncomingMail(incoming.value, fixture.env);

    expect(fixture.getByName).not.toHaveBeenCalled();
    expect(incoming.cancelled).toHaveBeenCalledOnce();
    expect(incoming.reject).toHaveBeenCalledWith("Mailbox unavailable");
  });

  it("rejects an oversized message before address resolution", async () => {
    const incoming = message(new Uint8Array([1]));
    Object.defineProperty(incoming.value, "rawSize", {
      value: 26_214_401,
    });
    const fixture = environment({ directoryResult: { found: false } });

    await handleIncomingMail(incoming.value, fixture.env);

    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.getByName).not.toHaveBeenCalled();
    expect(incoming.reject).toHaveBeenCalledWith(
      "Message exceeds this mailbox's size limit",
    );
  });
});

function outboundEnvironment(input: {
  deliveryError?: Error;
  directoryError?: Error;
} = {}) {
  const deliverOutbound = vi.fn(async () => {
    if (input.deliveryError) throw input.deliveryError;
  });
  const getByName = vi.fn(() => ({ deliverOutbound }));
  const resolveInstallation = vi.fn(async (installationId: string): Promise<InstallationDirectoryResult> => {
    if (input.directoryError) throw input.directoryError;
    return installationResult(installationId);
  });
  const resolveOutboundMailReference = vi.fn(async (): Promise<ManagedOutboundMailReference | null> => ({
    version: 1,
    outboundId: "outbound-command",
    fingerprint: `sha256:${"b".repeat(64)}`,
  }));
  const env = {
    MAIL_DOMAIN: "gsv.space",
    GSV_BASE_DOMAIN: "gsv.space",
    MAIL_MAX_MESSAGE_BYTES: 16_777_216,
    MAIL_DAILY_INBOUND_MESSAGE_LIMIT: 250,
    MAIL_DAILY_INBOUND_BYTE_LIMIT: 268_435_456,
    MAIL_DAILY_SUMMARIZATION_LIMIT: 100,
    MAIL_OUTBOUND_ENABLED: 1,
    MAIL_MAX_OUTBOUND_TEXT_BYTES: 1_048_576,
    MAIL_DAILY_OUTBOUND_MESSAGE_LIMIT: 10,
    MAIL_DAILY_OUTBOUND_BYTE_LIMIT: 10_000_000,
    ACCOUNTS: {
      resolveHostname: vi.fn(async () => ({ found: false as const })),
      resolveInstallation,
    },
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
    MAIL_INSTALLATIONS: asNamespace({ getByName }),
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
    GATEWAY: {
      resolveOutboundMailReference,
      acceptInboundMail: vi.fn<MailEnv["GATEWAY"]["acceptInboundMail"]>(),
      completeInboundMail: vi.fn<MailEnv["GATEWAY"]["completeInboundMail"]>(),
      claimOutboundMail: vi.fn<MailEnv["GATEWAY"]["claimOutboundMail"]>(),
      completeOutboundMail: vi.fn<MailEnv["GATEWAY"]["completeOutboundMail"]>(),
    },
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
    INFERENCE: {} as MailEnv["INFERENCE"],
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
    EMAIL: {} as MailEnv["EMAIL"],
  } satisfies MailEnv;
  return {
    env,
    deliverOutbound,
    getByName,
    resolveInstallation,
    resolveOutboundMailReference,
  };
}

function outboundCommand(installationId = "installation_hank") {
  return {
    version: 1,
    installationId,
    outboundId: "outbound-command",
    fingerprint: `sha256:${"a".repeat(64)}`,
  };
}

function installationResult(installationId: string, state: InstallationState = "active"): InstallationDirectoryResult {
  return { found: true, installationId, state, handle: "fixture", canonicalOrigin: "https://fixture.example.invalid" };
}

function queuedCommand(installationId = "installation_hank") {
  return { body: outboundCommand(installationId), attempts: 1, ack: vi.fn(), retry: vi.fn() };
}

describe("managed mail outbound queue handler", () => {
  it("resolves the immutable installation before selecting its mail owner", async () => {
    const fixture = outboundEnvironment();

    await handleOutboundCommand(outboundCommand(), fixture.env);

    expect(fixture.resolveInstallation).toHaveBeenCalledExactlyOnceWith("installation_hank");
    expect(fixture.resolveInstallation.mock.invocationCallOrder[0]).toBeLessThan(fixture.getByName.mock.invocationCallOrder[0]!);
    expect(fixture.getByName).toHaveBeenCalledWith("installation_hank");
    expect(fixture.deliverOutbound).toHaveBeenCalledWith(
      { installationId: "installation_hank" },
      outboundCommand(),
    );
    expect(fixture.resolveOutboundMailReference).not.toHaveBeenCalled();
  });

  it("resolves v2 metadata before selecting its mail owner", async () => {
    const fixture = outboundEnvironment();
    const { fingerprint: _fingerprint, ...command } = outboundCommand();

    await handleOutboundCommand({ ...command, version: 2 }, fixture.env);

    expect(fixture.resolveOutboundMailReference).toHaveBeenCalledExactlyOnceWith(
      { installationId: command.installationId }, { outboundId: command.outboundId },
    );
    expect(fixture.resolveOutboundMailReference.mock.invocationCallOrder[0]).toBeLessThan(fixture.getByName.mock.invocationCallOrder[0]!);
    expect(fixture.deliverOutbound).toHaveBeenCalledExactlyOnceWith(
      { installationId: command.installationId },
      { version: 1, outboundId: command.outboundId, fingerprint: `sha256:${"b".repeat(64)}` },
    );
  });

  it("acks a v2 reference whose authoritative outbox row is absent", async () => {
    const fixture = outboundEnvironment();
    fixture.resolveOutboundMailReference.mockResolvedValue(null);
    const message = { ...queuedCommand(), body: { version: 2, installationId: "installation_hank", outboundId: "outbound-command" } };

    await handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(fixture.getByName).not.toHaveBeenCalled();
  });

  it("acks a retired v2 reference without resolving its outbox or selecting its mail owner", async () => {
    const fixture = outboundEnvironment();
    fixture.resolveInstallation.mockResolvedValue(installationResult("installation_hank", "retained"));
    const message = { ...queuedCommand(), body: { version: 2, installationId: "installation_hank", outboundId: "outbound-command" } };

    await handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(fixture.resolveOutboundMailReference).not.toHaveBeenCalled();
    expect(fixture.getByName).not.toHaveBeenCalled();
  });

  it("acks a lost v2 lookup reply after retirement without selecting its mail owner", async () => {
    const fixture = outboundEnvironment();
    let rejectLookup!: (error: Error) => void;
    fixture.resolveOutboundMailReference.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLookup = reject; }));
    const message = { ...queuedCommand(), body: { version: 2, installationId: "installation_hank", outboundId: "outbound-command" } };
    const pending = handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);
    await vi.waitFor(() => expect(fixture.resolveOutboundMailReference).toHaveBeenCalledOnce());
    fixture.resolveInstallation.mockResolvedValue(installationResult("installation_hank", "retained"));
    rejectLookup(new Error("Lookup reply lost"));
    await pending;

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(fixture.getByName).not.toHaveBeenCalled();
    expect(fixture.resolveInstallation).toHaveBeenCalledTimes(2);
  });

  it.each(["unavailable", "mismatched", "invalid"] as const)("retries a v2 reference when the authoritative lookup is %s", async (state) => {
    const fixture = outboundEnvironment();
    if (state === "unavailable") fixture.resolveOutboundMailReference.mockRejectedValue(new Error("Gateway unavailable"));
    else fixture.resolveOutboundMailReference.mockResolvedValue({ version: 1, outboundId: state === "mismatched" ? "different-outbound" : "outbound-command", fingerprint: state === "invalid" ? "not-a-digest" : `sha256:${"b".repeat(64)}` });
    const message = { ...queuedCommand(), body: { version: 2, installationId: "installation_hank", outboundId: "outbound-command" } };

    await handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(fixture.getByName).not.toHaveBeenCalled();
  });

  it.each([
    { ...outboundCommand(), version: 2 },
    { ...outboundCommand(), version: 3 },
    { version: 1, installationId: "installation_hank", outboundId: "outbound-command" },
    { version: 2, installationId: "installation_hank", outboundId: "outbound-command", extra: "unexpected" },
  ])("acks malformed command $version without resolving or allocating", async (body) => {
    const fixture = outboundEnvironment();
    const message = { ...queuedCommand(), body };

    await handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    expect(fixture.resolveOutboundMailReference).not.toHaveBeenCalled();
    expect(fixture.getByName).not.toHaveBeenCalled();
  });

  it("retries without selecting a mail owner when Accounts is unavailable", async () => {
    const fixture = outboundEnvironment({
      directoryError: new Error("Accounts unavailable"),
    });
    const ack = vi.fn();
    const retry = vi.fn();
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
    const batch = asMessageBatch({
      messages: [{
        body: outboundCommand(),
        attempts: 100,
        ack,
        retry,
      }],
    });

    await handleOutboundBatch(batch, fixture.env);

    expect(fixture.resolveInstallation).toHaveBeenCalledExactlyOnceWith("installation_hank");
    expect(fixture.getByName).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 3_600 });
  });

  it("discards malformed commands without allocating state", async () => {
    const fixture = outboundEnvironment();

    await handleOutboundCommand({ version: 2 }, fixture.env);
    await handleOutboundCommand({
      ...outboundCommand(),
      fingerprint: "not-a-digest",
    }, fixture.env);

    expect(fixture.getByName).not.toHaveBeenCalled();
    expect(fixture.resolveInstallation).not.toHaveBeenCalled();
  });

  it.each(["retained", "deleting", "deleted", "missing"] as const)("acks %s A while delivering active B in the same batch", async (state) => {
    const fixture = outboundEnvironment();
    fixture.resolveInstallation.mockImplementation(async (id) => id === "installation_a"
      ? state === "missing" ? { found: false } : installationResult(id, state)
      : installationResult(id));
    const a = queuedCommand("installation_a");
    const b = queuedCommand("installation_b");

    await handleOutboundBatch(asMessageBatch({ messages: [a, b] }), fixture.env);

    expect(a.ack).toHaveBeenCalledOnce();
    expect(a.retry).not.toHaveBeenCalled();
    expect(b.ack).toHaveBeenCalledOnce();
    expect(b.retry).not.toHaveBeenCalled();
    expect(fixture.getByName).toHaveBeenCalledExactlyOnceWith("installation_b");
    expect(fixture.deliverOutbound).toHaveBeenCalledExactlyOnceWith({ installationId: "installation_b" }, b.body);
  });

  it.each(["reserved", "provisioning", "trialing", "past_due", "restricted", "cancelled"] as const)("retries a recoverable %s installation without selecting its mail owner", async (state) => {
    const fixture = outboundEnvironment();
    fixture.resolveInstallation.mockResolvedValue(installationResult("installation_hank", state));
    const message = queuedCommand();

    await handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);

    expect(fixture.getByName).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });

  it.each(["retained", "deleted", "missing"] as const)("acks a lost delivery reply after the original installation becomes %s", async (state) => {
    const fixture = outboundEnvironment();
    let rejectDelivery!: (error: Error) => void;
    fixture.deliverOutbound.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectDelivery = reject; }));
    const message = queuedCommand();
    const pending = handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);
    await vi.waitFor(() => expect(fixture.deliverOutbound).toHaveBeenCalledOnce());

    fixture.resolveInstallation.mockResolvedValue(state === "missing" ? { found: false } : installationResult("installation_hank", state));
    rejectDelivery(new Error("Delivery reply lost"));
    await pending;

    expect(fixture.resolveInstallation).toHaveBeenCalledTimes(2);
    expect(fixture.getByName).toHaveBeenCalledExactlyOnceWith("installation_hank");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it.each(["restricted", "unavailable", "mismatched"] as const)("preserves retry when the post-failure directory check is %s", async (state) => {
    const fixture = outboundEnvironment({ deliveryError: new Error("Delivery reply lost") });
    fixture.resolveInstallation.mockResolvedValueOnce(installationResult("installation_hank"));
    if (state === "unavailable") fixture.resolveInstallation.mockRejectedValueOnce(new Error("Accounts unavailable"));
    else fixture.resolveInstallation.mockResolvedValueOnce(installationResult(state === "mismatched" ? "replacement" : "installation_hank", state === "mismatched" ? "retained" : state));
    const message = queuedCommand();

    await handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);

    expect(fixture.resolveInstallation).toHaveBeenCalledTimes(2);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });

  it("does not discard a reference on a mismatched terminal directory result", async () => {
    const fixture = outboundEnvironment();
    fixture.resolveInstallation.mockResolvedValue(installationResult("replacement", "deleted"));
    const message = queuedCommand();

    await handleOutboundBatch(asMessageBatch({ messages: [message] }), fixture.env);

    expect(fixture.getByName).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });

  it("acknowledges poison messages and retries transient durable admission errors", async () => {
    const poison = outboundEnvironment();
    const transient = outboundEnvironment({
      deliveryError: new Error("Durable Object unavailable"),
    });
    const poisonAck = vi.fn();
    const poisonRetry = vi.fn();
    const transientAck = vi.fn();
    const transientRetry = vi.fn();
    const batch = asMessageBatch({
      messages: [
        {
          body: {
            ...outboundCommand(),
            fingerprint: "sha256:not-hex",
          },
          attempts: 1,
          ack: poisonAck,
          retry: poisonRetry,
        },
      ],
    });
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
// SAFETY: The test fixture supplies the concrete adapter contract for this assertion.
    const retryBatch = asMessageBatch({
      messages: [
        {
          body: outboundCommand(),
          attempts: 1,
          ack: transientAck,
          retry: transientRetry,
        },
      ],
    });

    await handleOutboundBatch(batch, poison.env);
    await handleOutboundBatch(retryBatch, transient.env);

    expect(poisonAck).toHaveBeenCalledOnce();
    expect(poisonRetry).not.toHaveBeenCalled();
    expect(transientAck).not.toHaveBeenCalled();
    expect(transientRetry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });
});
