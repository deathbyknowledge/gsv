import { bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/protocol";
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
  const resolveInstallation = vi.fn(async (): Promise<InstallationDirectoryResult> => {
    if (input.directoryError) throw input.directoryError;
    return { found: false };
  });
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
  } satisfies MailEnv;
  return {
    env,
    deliverOutbound,
    getByName,
    resolveInstallation,
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

describe("managed mail outbound queue handler", () => {
  it("durably admits a trusted command before any directory lookup", async () => {
    const fixture = outboundEnvironment();

    await handleOutboundCommand(outboundCommand(), fixture.env);

    expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    expect(fixture.getByName).toHaveBeenCalledWith("installation_hank");
    expect(fixture.deliverOutbound).toHaveBeenCalledWith(
      { installationId: "installation_hank" },
      outboundCommand(),
    );
  });

  it("acks durable admission even when Accounts is unavailable", async () => {
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

    expect(fixture.resolveInstallation).not.toHaveBeenCalled();
    expect(fixture.getByName).toHaveBeenCalledWith("installation_hank");
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("discards malformed commands without allocating state", async () => {
    const fixture = outboundEnvironment();

    await handleOutboundCommand({ version: 2 }, fixture.env);
    await handleOutboundCommand({
      ...outboundCommand(),
      fingerprint: "not-a-digest",
    }, fixture.env);

    expect(fixture.getByName).not.toHaveBeenCalled();
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
