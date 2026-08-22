import { WorkerEntrypoint } from "cloudflare:workers";
import {
  isAdapterInstallationContext,
  type AdapterInstallationContext,
  type BinaryBody,
  type ListManagedMailIntakesInput,
  type ManagedMailIntakeDiagnostic,
  type ManagedMailIntakePage,
  type ManagedMailService as ManagedMailServiceContract,
  type ManagedOutboundMailCommand,
} from "@humansandmachines/gsv/protocol";
import { resolveMailRecipient } from "./address";
import { mailLimits, type MailEnv } from "./env";

interface ExternalObject { [key: string]: ExternalValue; }
type ExternalValue = string | number | boolean | ExternalObject | null | undefined;

export { MailInstallation } from "./mail-installation";

export default class MailService
  extends WorkerEntrypoint<MailEnv>
  implements ManagedMailServiceContract
{
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
    return new Response("Not Found", { status: 404 });
  }

  async email(message: ForwardableEmailMessage): Promise<void> {
    await handleIncomingMail(message, this.env);
  }

  async queue(batch: MessageBatch): Promise<void> {
    await handleOutboundBatch(batch, this.env);
  }

  async getIntake(
    installationValue: AdapterInstallationContext,
    intakeId: string,
  ): Promise<ManagedMailIntakeDiagnostic | null> {
    const installation = await requireActiveInstallation(
      this.env,
      installationValue,
    );
    return await this.env.MAIL_INSTALLATIONS.getByName(
      installation.installationId,
    ).getIntake(installation, intakeId);
  }

  async listIntakes(
    installationValue: AdapterInstallationContext,
    input?: ListManagedMailIntakesInput,
  ): Promise<ManagedMailIntakePage> {
    const installation = await requireActiveInstallation(
      this.env,
      installationValue,
    );
    return await this.env.MAIL_INSTALLATIONS.getByName(
      installation.installationId,
    ).listIntakes(installation, input);
  }
}

export async function handleOutboundBatch(
  batch: MessageBatch,
  env: MailEnv,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleOutboundCommand(JSON.parse(JSON.stringify(message.body)), env);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: "managed_mail_outbound_queue_retry",
        error: errorName(error instanceof Error ? error : new Error(String(error))),
      }));
      message.retry({ delaySeconds: queueRetryDelay(message.attempts) });
    }
  }
}

export async function handleOutboundCommand(
  value: ExternalValue,
  env: MailEnv,
): Promise<void> {
  const command = parseOutboundCommand(value);
  if (!command) return;
  const installation = Object.freeze({
    installationId: command.installationId,
  });
  await env.MAIL_INSTALLATIONS.getByName(
    installation.installationId,
  ).deliverOutbound(installation, command);
}

export async function handleIncomingMail(
  message: ForwardableEmailMessage,
  env: MailEnv,
): Promise<void> {
  const limits = mailLimits(env);
  if (
    !Number.isSafeInteger(message.rawSize)
    || message.rawSize <= 0
    || message.rawSize > limits.maxMessageBytes
  ) {
    message.setReject("Message exceeds this mailbox's size limit");
    await cancelStream(message.raw, "Managed mail message is oversized");
    return;
  }

  let recipient;
  try {
    recipient = await resolveMailRecipient(
      env.ACCOUNTS,
      message.to,
      env.MAIL_DOMAIN,
      env.GSV_BASE_DOMAIN,
    );
  } catch (error) {
    await cancelStream(message.raw, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  if (!recipient) {
    message.setReject("Mailbox unavailable");
    await cancelStream(message.raw, "Managed mail recipient is unavailable");
    return;
  }

  const body: BinaryBody = {
    stream: message.raw,
    length: message.rawSize,
  };
  const installation = env.MAIL_INSTALLATIONS.getByName(
    recipient.installation.installationId,
  );
  const result = await installation.intake(
    recipient.installation,
    {
      from: message.from,
      to: message.to,
      rawSize: message.rawSize,
    },
    body,
  );
  if (result.status === "rejected") {
    message.setReject(result.reason === "quota"
      ? "Mailbox quota exceeded"
      : "Message could not be accepted");
  }
}

async function requireActiveInstallation(
  env: MailEnv,
  value: AdapterInstallationContext,
): Promise<AdapterInstallationContext> {
  if (!isAdapterInstallationContext(value)) {
    throw new Error("Mail installation context is invalid");
  }
  const installation = await resolveActiveInstallation(
    env,
    value.installationId,
  );
  if (!installation) {
    throw new Error("Mail installation is unavailable");
  }
  return installation;
}

async function resolveActiveInstallation(
  env: MailEnv,
  installationId: string,
): Promise<AdapterInstallationContext | null> {
  const result = await env.ACCOUNTS.resolveInstallation(installationId);
  if (
    !result.found
    || result.state !== "active"
    || result.installationId !== installationId
  ) {
    return null;
  }
  return Object.freeze({ installationId: result.installationId });
}

function parseOutboundCommand(value: ExternalValue): ManagedOutboundMailCommand | null {
  if (!value || value.constructor !== Object) return null;
  // SAFETY: The constructor guard establishes a plain command object.
  const command = value as Record<string, ExternalValue>;
  if (
    command.version !== 1
    || String(command.installationId) !== command.installationId
    || command.installationId === undefined
    || !boundedOutboundId(command.outboundId)
    || !validFingerprint(command.fingerprint)
  ) {
    return null;
  }
  return {
    version: 1,
    installationId: command.installationId,
    outboundId: command.outboundId,
    fingerprint: command.fingerprint,
  };
}

function validFingerprint(value: ExternalValue): value is string {
  return String(value) === value && /^sha256:[0-9a-f]{64}$/.test(value);
}

function boundedOutboundId(value: ExternalValue): value is string {
  return String(value) === value
    && new TextEncoder().encode(value).byteLength <= 256
    && /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(value);
}

function queueRetryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(10, attempts - 1));
  return Math.min(3_600, 5 * 2 ** exponent);
}

function errorName(error: Error | string | null | undefined): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

async function cancelStream(
  stream: ReadableStream<Uint8Array>,
  reason: Error | string | null | undefined,
): Promise<void> {
  if (!stream.locked) await stream.cancel(reason).catch(() => {});
}
