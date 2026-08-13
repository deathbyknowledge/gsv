import { bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryResult } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import type { MailEnv } from "../src/env";
import { handleIncomingMail } from "../src/index";

const encoder = new TextEncoder();

function environment(input: {
  directoryResult: Awaited<ReturnType<MailEnv["ACCOUNTS"]["resolveHostname"]>>;
  intake?: ReturnType<typeof vi.fn>;
}): {
  env: MailEnv;
  getByName: ReturnType<typeof vi.fn>;
  resolveHostname: ReturnType<typeof vi.fn>;
} {
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
      ACCOUNTS: {
        resolveHostname,
        resolveInstallation: vi.fn(async (): Promise<InstallationDirectoryResult> => ({
          found: false,
        })),
      },
      MAIL_INSTALLATIONS: { getByName } as unknown as MailEnv["MAIL_INSTALLATIONS"],
      GATEWAY: {} as MailEnv["GATEWAY"],
      INFERENCE: {} as MailEnv["INFERENCE"],
    },
    getByName,
    resolveHostname,
  };
}

function message(
  raw: Uint8Array,
  to = "hank@gsv.space",
): {
  value: ForwardableEmailMessage;
  reject: ReturnType<typeof vi.fn>;
  cancelled: ReturnType<typeof vi.fn>;
  pulls: () => number;
} {
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
  };
}

describe("managed mail email handler", () => {
  it("resolves an active address before allocating its installation object", async () => {
    const raw = encoder.encode("Subject: hello\r\n\r\nbody");
    const incoming = message(raw);
    const intake = vi.fn(async (
      installation: { installationId: string },
      _envelope: unknown,
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
