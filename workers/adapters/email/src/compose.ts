/**
 * Writes the MIME message the email Worker hands to Email Sending. Bodies are quoted-printable
 * and header text outside ASCII becomes RFC 2047 encoded words, so the message survives any
 * relay. Email Sending adds Date, Message-ID and its signature, so the message carries none.
 * An invite travels as RFC 6047 describes, beside the text and HTML, and again as an attachment
 * for mail apps that only look there, as calendar services send theirs.
 */

const CRLF = "\r\n";
const TEXT_ENCODER = new TextEncoder();
// A boundary starts with "=_", which quoted-printable and base64 output can never contain.
const BOUNDARY_PREFIX = "=_gsv_";
const MAX_HEADER_LINE = 78;
const MAX_ENCODED_LINE = 76;
// 39 bytes make a 64-character encoded word, so a header line holding one stays within
// RFC 2047's 76 characters even after "Subject: ".
const MAX_ENCODED_WORD_BYTES = 39;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** A message as recipients see it, with its rendered text and HTML. */
export type ComposedMail = {
  from: string;
  fromName?: string;
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  inReplyTo?: string;
  references?: string;
  text: string;
  html: string;
  invite?: { method: "REQUEST" | "CANCEL"; text: string };
};

type Part = { headers: string[]; body: string };

export function composeMail(mail: ComposedMail): string {
  const views = [textPart("text/plain", mail.text), textPart("text/html", mail.html)];
  const body = mail.invite
    ? multipart("mixed", [
      multipart("alternative", [
        ...views,
        base64Part([`Content-Type: text/calendar; charset=UTF-8; method=${mail.invite.method}`], mail.invite.text),
      ]),
      base64Part([
        'Content-Type: application/ics; name="invite.ics"',
        'Content-Disposition: attachment; filename="invite.ics"',
      ], mail.invite.text),
    ])
    : multipart("alternative", views);
  const headers = [
    header("From", mail.fromName ? `${phrase(mail.fromName)} <${mail.from}>` : mail.from),
    header("To", mail.to.join(", ")),
    ...(mail.cc?.length ? [header("Cc", mail.cc.join(", "))] : []),
    unstructured("Subject", mail.subject),
    ...(mail.inReplyTo ? [header("In-Reply-To", mail.inReplyTo)] : []),
    ...(mail.references ? [header("References", mail.references)] : []),
    "MIME-Version: 1.0",
    ...body.headers,
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body.body}${CRLF}`;
}

function multipart(subtype: "alternative" | "mixed", parts: readonly Part[]): Part {
  const boundary = `${BOUNDARY_PREFIX}${randomHex(16)}`;
  const lines = parts.flatMap((part) => [`--${boundary}`, ...part.headers, "", part.body]);
  return {
    headers: [header("Content-Type", `multipart/${subtype}; boundary="${boundary}"`)],
    body: [...lines, `--${boundary}--`].join(CRLF),
  };
}

function textPart(type: "text/plain" | "text/html", text: string): Part {
  return {
    headers: [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: quoted-printable"],
    body: quotedPrintable(text),
  };
}

/** Base64 keeps an iCalendar object's own CRLF lines exactly as written. */
function base64Part(headers: readonly string[], text: string): Part {
  const encoded = base64(TEXT_ENCODER.encode(text));
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += MAX_ENCODED_LINE) {
    lines.push(encoded.slice(index, index + MAX_ENCODED_LINE));
  }
  return { headers: [...headers, "Content-Transfer-Encoding: base64"], body: lines.join(CRLF) };
}

/** One header, folded before spaces so its lines stay short. */
function header(name: string, value: string): string {
  const [first, ...rest] = value.split(/(?= )/);
  const lines: string[] = [];
  let line = `${name}: ${first}`;
  for (const piece of rest) {
    if (line.length + piece.length > MAX_HEADER_LINE && line.trim().length > 0) {
      lines.push(line);
      line = piece;
    } else {
      line += piece;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/** A display name: a quoted string in ASCII, otherwise encoded words. */
function phrase(text: string): string {
  return PRINTABLE_ASCII.test(text) && !text.includes("=?")
    ? `"${text.replace(/["\\]/g, "\\$&")}"`
    : encodedWords(text);
}

/** An unstructured header: plain ASCII when each word fits on a folded line, otherwise encoded words. */
function unstructured(name: string, text: string): string {
  const plain = PRINTABLE_ASCII.test(text)
    && !text.includes("=?")
    && text.split(" ").every((word) => `${name}: ${word}`.length <= MAX_HEADER_LINE);
  return header(name, plain ? text : encodedWords(text));
}

/** RFC 2047 base64 words, split between characters; readers drop the spaces between them. */
function encodedWords(text: string): string {
  const words: string[] = [];
  let word = "";
  for (const character of text) {
    if (word && TEXT_ENCODER.encode(word + character).byteLength > MAX_ENCODED_WORD_BYTES) {
      words.push(word);
      word = "";
    }
    word += character;
  }
  if (word) words.push(word);
  return words.map((value) => `=?UTF-8?B?${base64(TEXT_ENCODER.encode(value))}?=`).join(" ");
}

/** Quoted-printable with CRLF lines: soft breaks keep each line within 76 characters. */
function quotedPrintable(text: string): string {
  return text.split(/\r\n|\r|\n/).map((line) => {
    const bytes = TEXT_ENCODER.encode(line);
    const encoded: string[] = [];
    let current = "";
    bytes.forEach((byte, index) => {
      // Whitespace that ends a line is escaped, since relays may strip it.
      const literal = (byte >= 33 && byte <= 126 && byte !== 61)
        || ((byte === 32 || byte === 9) && index < bytes.length - 1);
      const token = literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      if (current.length + token.length > MAX_ENCODED_LINE - 1) {
        encoded.push(`${current}=`);
        current = "";
      }
      current += token;
    });
    encoded.push(current);
    return encoded.join(CRLF);
  }).join(CRLF);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
