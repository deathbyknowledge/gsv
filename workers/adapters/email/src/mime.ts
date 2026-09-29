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
const MAX_ADDRESSES_PER_FIELD = 200;
const MAX_ATTACHMENTS = 256;
const MAX_ADDRESS_BYTES = 512;
interface SerializedObject { [key: string]: SerializedValue; }
type SerializedValue = string | number | boolean | SerializedObject | SerializedValue[] | null | undefined;
const MAX_NAME_BYTES = 512;
const MAX_SUBJECT_BYTES = 4_096;
const MAX_RFC_MESSAGE_ID_BYTES = 2_048;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_SUMMARY_SUBJECT_BYTES = 1_024;
const MAX_SUMMARY_TEXT_BYTES = 64 * 1024;
const MAX_FILENAME_BYTES = 1_024;
const MAX_MIME_TYPE_BYTES = 256;
const MAX_CONTENT_ID_BYTES = 1_024;
const MAX_METADATA_JSON_BYTES = 1024 * 1024;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

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
  const source = raw.buffer instanceof ArrayBuffer
    && raw.byteOffset === 0
    && raw.byteLength === raw.buffer.byteLength
    ? raw.buffer
    : raw.slice().buffer;
  const email = await PostalMime.parse(source, {
    attachmentEncoding: "arraybuffer",
    maxHeadersSize: MAX_HEADER_BYTES,
    maxNestingDepth: MAX_MIME_NESTING,
    maxRfc822NestingDepth: MAX_RFC822_NESTING,
  });
  const from = firstMailbox(email.from);
  const rfcMessageId = boundedText(
    sanitizeHeaderText(email.messageId),
    MAX_RFC_MESSAGE_ID_BYTES,
  );
  const subject = boundedText(sanitizeHeaderText(email.subject), MAX_SUBJECT_BYTES);
  const text = boundedText(sanitizeBodyText(email.text), MAX_TEXT_BYTES);
  const html = boundedText(sanitizeBodyText(email.html), MAX_HTML_BYTES);
  const summarySubject = boundedText(
    (email.subject ?? "").replace(/[\r\n]/g, " ").replaceAll("\0", ""),
    MAX_SUMMARY_SUBJECT_BYTES,
  ) ?? "";
  const summaryText = boundedText(
    (email.text || email.subject || "Message has no text body").replaceAll("\0", ""),
    MAX_SUMMARY_TEXT_BYTES,
  )?.trim() ?? "";
  const metadata = compactMetadata({
    version: 1,
    intakeId: input.intakeId,
    digest: input.digest,
    receivedAt: input.receivedAt,
    rawSize: raw.byteLength,
    envelope: {
      from: requiredAddress(input.envelopeFrom, "envelopeFrom"),
      to: requiredAddress(input.envelopeTo, "envelopeTo"),
    },
    rfcMessageId,
    sentAt: mailDate(email),
    from,
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    replyTo: mailboxes(email.replyTo),
    subject,
    text,
    html,
    attachments: email.attachments
      .slice(0, MAX_ATTACHMENTS)
      .map(attachmentMetadata),
  });
  return {
    metadata,
    summaryInput: {
      from: from?.address ?? requiredAddress(input.envelopeFrom, "envelopeFrom"),
      subject: summarySubject,
      text: summarySubject.trim().length === 0 && summaryText.length === 0
        ? "Message has no text body"
        : summaryText,
    },
  };
}

function compactMetadata(
  metadata: ManagedInboundMailMetadata,
): ManagedInboundMailMetadata {
  if (serializedBytes(metadata) <= MAX_METADATA_JSON_BYTES) return metadata;
  delete metadata.html;
  if (serializedBytes(metadata) <= MAX_METADATA_JSON_BYTES) return metadata;
  metadata.attachments = metadata.attachments.slice(0, 50);
  metadata.to = metadata.to.slice(0, 25);
  metadata.cc = metadata.cc.slice(0, 25);
  metadata.replyTo = metadata.replyTo.slice(0, 25);
  if (serializedBytes(metadata) <= MAX_METADATA_JSON_BYTES) return metadata;
  delete metadata.text;
  if (serializedBytes(metadata) <= MAX_METADATA_JSON_BYTES) return metadata;
  return {
    version: metadata.version,
    intakeId: metadata.intakeId,
    digest: metadata.digest,
    receivedAt: metadata.receivedAt,
    rawSize: metadata.rawSize,
    envelope: metadata.envelope,
    to: [],
    cc: [],
    replyTo: [],
    attachments: [],
  };
}

function serializedBytes(value: SerializedValue): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
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
    for (const entry of address.group) {
      const candidate = mailbox(entry);
      if (candidate) return candidate;
    }
    return undefined;
  }
  return mailbox(address) ?? undefined;
}

function mailbox(value: Mailbox): ManagedMailAddress | null {
  const address = optionalAddress(value.address);
  if (!address) return null;
  const name = boundedText(sanitizeHeaderText(value.name), MAX_NAME_BYTES)?.trim();
  return {
    address,
    name,
  };
}

function attachmentMetadata(
  attachment: Attachment,
): ManagedMailAttachmentMetadata {
  const filename = boundedText(
    sanitizeHeaderText(attachment.filename ?? undefined),
    MAX_FILENAME_BYTES,
  );
  const mimeType = boundedText(
    sanitizeHeaderText(attachment.mimeType),
    MAX_MIME_TYPE_BYTES,
  )?.trim()
    || "application/octet-stream";
  const contentId = boundedText(
    sanitizeHeaderText(attachment.contentId),
    MAX_CONTENT_ID_BYTES,
  );
  const disposition = attachmentDisposition(attachment.disposition);
  return {
    mimeType,
    size: attachmentSize(attachment.content),
    filename,
    disposition,
    contentId,
  };
}

function attachmentDisposition(
  value: Attachment["disposition"],
): ManagedMailAttachmentMetadata["disposition"] | undefined {
  return value === "attachment" || value === "inline" ? value : undefined;
}

function attachmentSize(content: Attachment["content"]): number {
  if (String(content) === content) return TEXT_ENCODER.encode(String(content)).byteLength;
  return new Blob([content]).size;
}

function mailDate(email: Email): number | undefined {
  if (!email.date) return undefined;
  const value = Date.parse(email.date);
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
    ? value
    : undefined;
}

function boundedText(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  const bytes = new Uint8Array(maxBytes);
  const encoded = TEXT_ENCODER.encodeInto(value, bytes);
  return encoded.read === value.length
    ? value
    : TEXT_DECODER.decode(bytes.subarray(0, encoded.written));
}

function sanitizeHeaderText(value: string | undefined): string | undefined {
  return value?.replace(/\p{Cc}/gu, " ");
}

function sanitizeBodyText(value: string | undefined): string | undefined {
  return value?.replace(/\p{Cc}/gu, "");
}

function optionalAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const address = value.trim().toLowerCase();
  return isValidAddress(address) ? address : undefined;
}

function requiredAddress(value: string, name: string): string {
  const address = value.toLowerCase();
  if (!isValidAddress(address)) {
    throw new Error(`Managed mail ${name} is invalid`);
  }
  return address;
}

function isValidAddress(value: string): boolean {
  if (TEXT_ENCODER.encode(value).byteLength > MAX_ADDRESS_BYTES) return false;
  const separator = value.lastIndexOf("@");
  return separator > 0
    && separator < value.length - 1
    && !/\s/.test(value);
}
