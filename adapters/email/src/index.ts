import { WorkerEntrypoint } from "cloudflare:workers";
import {
  isAdapterInstallationContext,
  type AdapterInstallationContext,
  type BinaryBody,
  type ListManagedMailIntakesInput,
  type ManagedMailIntakeDiagnostic,
  type ManagedMailIntakePage,
  type ManagedMailService as ManagedMailServiceContract,
} from "@humansandmachines/gsv/protocol";
import { resolveMailRecipient } from "./address";
import { mailLimits, type MailEnv } from "./env";

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
    await cancelStream(message.raw, error);
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
  const result = await env.ACCOUNTS.resolveInstallation(value.installationId);
  if (
    !result.found
    || result.state !== "active"
    || result.installationId !== value.installationId
  ) {
    throw new Error("Mail installation is unavailable");
  }
  return Object.freeze({ installationId: result.installationId });
}

async function cancelStream(
  stream: ReadableStream<Uint8Array>,
  reason: unknown,
): Promise<void> {
  if (!stream.locked) await stream.cancel(reason).catch(() => {});
}
