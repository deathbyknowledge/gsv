import { z } from "zod/mini";

/*
 * Lexicon validation where zod/mini means something else.
 *
 * Text within the lexicon's limits: graphemes, as people count characters, and
 * UTF-8 bytes. A Lexicon string's minLength and maxLength count UTF-8 bytes, not
 * the UTF-16 code units zod counts. The string formats are atcute's syntax
 * checks (@atcute/lexicons/syntax), so a CID is a DASL CID: CIDv1, base32,
 * dag-cbor or raw, SHA-256.
 */

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

export function graphemeLength(value: string): number {
  let count = 0;
  for (const _ of segmenter.segment(value)) count += 1;
  return count;
}

// Each UTF-16 code unit is at most three UTF-8 bytes and at least part of one grapheme,
// so a short string passes without being encoded or segmented.
export function utf8MinLength(limit: number) {
  return z.refine<string>((value) => value.length * 3 >= limit && utf8Length(value) >= limit, `Must be at least ${limit} UTF-8 bytes`);
}

export function utf8MaxLength(limit: number) {
  return z.refine<string>((value) => value.length * 3 <= limit || utf8Length(value) <= limit, `Must be at most ${limit} UTF-8 bytes`);
}

export function minGraphemes(limit: number) {
  return z.refine<string>((value) => value.length >= limit && graphemeLength(value) >= limit, `Must be at least ${limit} characters`);
}

export function maxGraphemes(limit: number) {
  return z.refine<string>((value) => value.length <= limit || graphemeLength(value) <= limit, `Must be at most ${limit} characters`);
}

const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const HANDLE = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const NSID = /^[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+\.[a-zA-Z][a-zA-Z0-9]{0,62}?$/;
const RECORD_KEY = /^(?!\.{1,2}$)[a-zA-Z0-9_~.:-]{1,512}$/;
const AT_URI = /^at:\/\/([a-zA-Z0-9._:%-]+)(?:\/([a-zA-Z0-9-.]+)(?:\/([a-zA-Z0-9._~:@!$&%')(*+,;=-]+))?)?(?:#(\/[a-zA-Z0-9._~:@!$&%')(*+,;=\-[\]/\\]*))?$/;
const DATETIME = /^((?!0{3})\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T((?:[01]\d|2[0-3]):(?:[0-5]\d):(?:[0-5]\d))(\.\d+)?(Z|(?!-00:00)[+-](?:[01]\d|2[0-3]):(?:[0-5]\d))$/;
const CID = /^baf[ky]re(?:aa|i[a-z2-7]{52})$/;

export function isDid(value: string): boolean {
  return value.length >= 7 && value.length <= 2_048 && DID.test(value);
}

export function isHandle(value: string): boolean {
  return value.length >= 3 && value.length <= 253 && HANDLE.test(value);
}

function isNsid(value: string): boolean {
  return value.length >= 5 && value.length <= 317 && NSID.test(value);
}

function isRecordKey(value: string): boolean {
  return value.length >= 1 && value.length <= 512 && RECORD_KEY.test(value);
}

export function isAtUri(value: string): boolean {
  const match = AT_URI.exec(value);
  if (!match) return false;
  const [, repository = "", collection, recordKey] = match;
  return (isDid(repository) || isHandle(repository))
    && (collection === undefined || isNsid(collection))
    && (recordKey === undefined || isRecordKey(recordKey));
}

export function isDatetime(value: string): boolean {
  return value.length >= 20 && value.length <= 64 && DATETIME.test(value);
}

export function isCid(value: string): boolean {
  return (value.length === 8 || value.length === 59) && CID.test(value);
}

const FORMATS = {
  "at-uri": isAtUri,
  cid: isCid,
  datetime: isDatetime,
  did: isDid,
  handle: isHandle,
};

export type LexiconStringFormat = keyof typeof FORMATS;

export function stringFormat(format: LexiconStringFormat) {
  return z.refine<string>(FORMATS[format], `Must be a valid ${format}`);
}

/** A MIME type a blob's `accept` allows: exact, `type/*`, or any type at all. */
export function mimeTypeAccept(accept: readonly string[]) {
  return z.refine<string>((value) => value.includes("/") && accept.some((pattern) => (
    pattern === "*/*" || pattern === value || (pattern.endsWith("/*") && value.startsWith(pattern.slice(0, -1)))
  )), `Must be one of ${accept.join(", ")}`);
}

/** A blob as its JSON names it: the CID of its bytes, its MIME type and its size. */
export type LexiconBlob = {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
};
