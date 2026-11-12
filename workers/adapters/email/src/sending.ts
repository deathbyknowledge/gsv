import * as z from "zod/mini";
import type { MailSending } from "./env";

/** Long enough for Email Sending's immediate delivery attempt, well inside the attempt's expiry. */
const SEND_TIMEOUT_MS = 60_000;

/** What Email Sending did with a message it took, by recipient address. */
export type SentMail = {
  messageId?: string;
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
  /** Present only when the sending domain drops suppressed recipients instead of refusing. */
  suppressed: string[];
};

/** An error response from the Email Sending API: the request was answered and refused. */
export class EmailSendingError extends Error {
  override readonly name = "EmailSendingError";

  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

const addressesSchema = z.catch(z.array(z.string()), []);
const resultSchema = z.object({
  success: z.literal(true),
  result: z.object({
    message_id: z.optional(z.string()),
    delivered: addressesSchema,
    queued: addressesSchema,
    permanent_bounces: addressesSchema,
    suppressed_recipients: addressesSchema,
  }),
});
const errorSchema = z.object({
  errors: z.array(z.object({ code: z.optional(z.number()), message: z.optional(z.string()) })),
});

/**
 * Sends one MIME message through Email Sending's raw endpoint. The envelope names the sender and
 * every To and Cc address; the message's own headers decide what recipients see.
 */
export async function sendRawMail(
  sending: MailSending,
  message: { from: string; recipients: readonly string[]; mime: string },
  signal: AbortSignal,
): Promise<SentMail> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${sending.accountId}/email/sending/send_raw`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${sending.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ from: message.from, recipients: message.recipients, mime_message: message.mime }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
    },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = errorSchema.safeParse(body).data?.errors[0];
    throw new EmailSendingError(
      error?.message ?? `Email Sending answered ${response.status}`,
      response.status,
      error?.code,
      response.headers.get("cf-ray") ?? undefined,
    );
  }
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) throw new Error("Email Sending returned an unreadable result");
  const result = parsed.data.result;
  return {
    messageId: result.message_id,
    delivered: result.delivered,
    queued: result.queued,
    permanentBounces: result.permanent_bounces,
    suppressed: result.suppressed_recipients,
  };
}
