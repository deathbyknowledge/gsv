import type {
  ManagedInboundMailMetadata,
  ManagedMailAddress,
  ManagedMailAttachmentMetadata,
} from "@humansandmachines/gsv/protocol";
import PostalMime, {
  type Address,
  type Attachment,
  type Email,
  type Mailbox,
} from "postal-mime";

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_MIME_NESTING = 64;
const MAX_RFC822_NESTING = 2;
const MAX_ADDRESSES_PER_FIELD = 100;
const MAX_ATTACHMENTS = 100;
const MAX_ADDRESS_LENGTH = 320;
const MAX_NAME_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 2_048;
const MAX_TEXT_LENGTH = 128 * 1024;
const MAX_HTML_LENGTH = 512 * 1024;
const MAX_SUMMARY_TEXT_LENGTH = 64 * 1024;
const MAX_FILENAME_LENGTH = 1_024;
const MAX_MIME_TYPE_LENGTH = 255;
const MAX_CONTENT_ID_LENGTH = 1_024;

export type ParsedMail = {
  metadata: ManagedInboundMailMetadata;
  summaryInput: {
    from: string;
    subject: string;
    text: string;
  };
};

export async function parseMail(
  raw: Uint8Array,
  input: {
    intakeId: string;
    digest: string;
    receivedAt: number;
    envelopeFrom: string;
    envelopeTo: string;
  },
): Promise<ParsedMail> {
  const email = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
    maxHeadersSize: MAX_HEADER_BYTES,
    maxNestingDepth: MAX_MIME_NESTING,
    maxRfc822NestingDepth: MAX_RFC822_NESTING,
  });
  const from = firstMailbox(email.from);
  const subject = bounded(email.subject, MAX_SUBJECT_LENGTH);
  const text = bounded(email.text, MAX_TEXT_LENGTH);
  const html = bounded(email.html, MAX_HTML_LENGTH);
  const metadata: ManagedInboundMailMetadata = {
    version: 1,
    intakeId: input.intakeId,
    digest: input.digest,
    receivedAt: input.receivedAt,
    rawSize: raw.byteLength,
    envelope: {
      from: boundedRequired(input.envelopeFrom, MAX_ADDRESS_LENGTH),
      to: boundedRequired(input.envelopeTo, MAX_ADDRESS_LENGTH),
    },
    ...(bounded(email.messageId, MAX_CONTENT_ID_LENGTH)
      ? { rfcMessageId: bounded(email.messageId, MAX_CONTENT_ID_LENGTH) }
      : {}),
    ...(mailDate(email) === undefined ? {} : { sentAt: mailDate(email) }),
    ...(from ? { from } : {}),
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    replyTo: mailboxes(email.replyTo),
    ...(subject === undefined ? {} : { subject }),
    ...(text === undefined ? {} : { text }),
    ...(html === undefined ? {} : { html }),
    attachments: email.attachments
      .slice(0, MAX_ATTACHMENTS)
      .map(attachmentMetadata),
  };
  return {
    metadata,
    summaryInput: {
      from: boundedRequired(
        from?.address || input.envelopeFrom,
        MAX_ADDRESS_LENGTH,
      ),
      subject: subject ?? "",
      text: bounded(
        email.text || email.subject || "Message has no text body",
        MAX_SUMMARY_TEXT_LENGTH,
      )?.trim() ?? "",
    },
  };
}

function mailboxes(addresses: Address[] | undefined): ManagedMailAddress[] {
  const flattened: Mailbox[] = [];
  for (const address of addresses ?? []) {
    if (address.group) {
      flattened.push(...address.group);
    } else {
      flattened.push(address);
    }
    if (flattened.length >= MAX_ADDRESSES_PER_FIELD) break;
  }
  return flattened
    .slice(0, MAX_ADDRESSES_PER_FIELD)
    .map(mailbox)
    .filter((address): address is ManagedMailAddress => address !== null);
}

function firstMailbox(address: Address | undefined): ManagedMailAddress | undefined {
  if (!address) return undefined;
  if (address.group) {
    const first = address.group[0];
    return first ? mailbox(first) ?? undefined : undefined;
  }
  return mailbox(address) ?? undefined;
}

function mailbox(value: Mailbox): ManagedMailAddress | null {
  const address = bounded(value.address, MAX_ADDRESS_LENGTH)?.trim();
  if (!address) return null;
  const name = bounded(value.name, MAX_NAME_LENGTH)?.trim();
  return {
    address,
    ...(name ? { name } : {}),
  };
}

function attachmentMetadata(
  attachment: Attachment,
): ManagedMailAttachmentMetadata {
  const filename = bounded(attachment.filename ?? undefined, MAX_FILENAME_LENGTH);
  const mimeType = bounded(attachment.mimeType, MAX_MIME_TYPE_LENGTH)
    || "application/octet-stream";
  const contentId = bounded(attachment.contentId, MAX_CONTENT_ID_LENGTH);
  return {
    mimeType,
    size: attachmentSize(attachment.content),
    ...(filename ? { filename } : {}),
    ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
    ...(contentId ? { contentId } : {}),
  };
}

function attachmentSize(content: Attachment["content"]): number {
  if (typeof content === "string") return new TextEncoder().encode(content).byteLength;
  return content.byteLength;
}

function mailDate(email: Email): number | undefined {
  if (!email.date) return undefined;
  const value = Date.parse(email.date);
  return Number.isFinite(value) ? value : undefined;
}

function bounded(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function boundedRequired(value: string, maxLength: number): string {
  return bounded(value, maxLength) ?? "";
}
