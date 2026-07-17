import {
  encodeBase64Url,
  encodeU32,
  encodeU64,
  equalBytes,
} from "./bytes";
import { canonicalJsonBytes, assertValidUnicode } from "./canonical-json";
import { type PortableCrypto, sha256Parts } from "./crypto";
import { fail } from "./error";
import { MAX_FRAME_BODY_BYTES } from "./constants";

const SEMANTIC_DIGEST_DOMAIN = new Uint8Array([
  0x47, 0x53, 0x56, 0x53, 0x00, 0x01, 0x0a,
]);
const textEncoder = new TextEncoder();

export type SemanticFrameInputV1 = Readonly<{
  kind: string;
  part: number;
  bodyMediaType: string;
  bodyEncoding?: "identity";
  body: Uint8Array;
}>;

/**
 * Streaming normalization-policy-v1 digest for one logical object.
 *
 * The digest deliberately excludes archive sequence numbers, offsets, the
 * global frame chain, and encryption. It includes stable per-object part
 * boundaries, so an owning body codec must partition the same logical value
 * deterministically.
 */
export class ObjectSemanticDigestV1 {
  readonly objectId: string;
  readonly #crypto?: PortableCrypto;
  #state: Uint8Array;
  #nextPartByKind = new Map<string, number>();

  private constructor(objectId: string, state: Uint8Array, crypto?: PortableCrypto) {
    this.objectId = objectId;
    this.#state = state;
    this.#crypto = crypto;
  }

  static async create(
    objectId: string,
    crypto?: PortableCrypto,
  ): Promise<ObjectSemanticDigestV1> {
    validateSemanticIdentifier(objectId);
    const objectIdBytes = textEncoder.encode(objectId);
    const state = await sha256Parts(
      [SEMANTIC_DIGEST_DOMAIN, encodeU32(objectIdBytes.byteLength), objectIdBytes],
      crypto,
    );
    return new ObjectSemanticDigestV1(objectId, state, crypto);
  }

  async append(frame: SemanticFrameInputV1): Promise<void> {
    validateSemanticFrame(frame);
    const expectedPart = this.#nextPartByKind.get(frame.kind) ?? 0;
    if (frame.part !== expectedPart) {
      fail(
        "invalid_frame",
        `semantic parts for ${frame.kind} must start at zero and be contiguous`,
      );
    }
    this.#nextPartByKind.set(frame.kind, expectedPart + 1);
    const metadata = canonicalJsonBytes({
      bodyEncoding: frame.bodyEncoding ?? "identity",
      bodyMediaType: frame.bodyMediaType,
      kind: frame.kind,
      part: frame.part,
    });
    const recordDigest = await sha256Parts(
      [
        encodeU32(metadata.byteLength),
        metadata,
        encodeU64(BigInt(frame.body.byteLength)),
        frame.body,
      ],
      this.#crypto,
    );
    this.#state = await sha256Parts(
      [SEMANTIC_DIGEST_DOMAIN, this.#state, recordDigest],
      this.#crypto,
    );
  }

  digest(): Uint8Array {
    return this.#state.slice();
  }

  digestBase64Url(): string {
    return encodeBase64Url(this.#state);
  }

  matches(expected: Uint8Array): boolean {
    return equalBytes(this.#state, expected);
  }
}

export async function computeObjectSemanticDigestV1(
  objectId: string,
  frames: Iterable<SemanticFrameInputV1> | AsyncIterable<SemanticFrameInputV1>,
  crypto?: PortableCrypto,
): Promise<Uint8Array> {
  const digest = await ObjectSemanticDigestV1.create(objectId, crypto);
  for await (const frame of frames) await digest.append(frame);
  return digest.digest();
}

function validateSemanticFrame(frame: SemanticFrameInputV1): void {
  if (
    typeof frame.kind !== "string" ||
    !SEMANTIC_FRAME_KINDS.has(frame.kind)
  ) {
    fail("invalid_frame", "semantic frame kind is invalid");
  }
  if (
    !Number.isInteger(frame.part) ||
    frame.part < 0 ||
    frame.part > 0xffff_ffff
  ) {
    fail("invalid_frame", "semantic frame part is outside the u32 range");
  }
  if (
    typeof frame.bodyMediaType !== "string" ||
    frame.bodyMediaType.length > 127 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/.test(
      frame.bodyMediaType,
    )
  ) {
    fail("invalid_frame", "semantic frame media type is invalid");
  }
  if (frame.bodyEncoding !== undefined && frame.bodyEncoding !== "identity") {
    fail("invalid_frame", "semantic frame encoding must be identity in v1");
  }
  if (!(frame.body instanceof Uint8Array)) {
    fail("invalid_frame", "semantic frame body must be a Uint8Array");
  }
  if (frame.body.byteLength > MAX_FRAME_BODY_BYTES) {
    fail("limit_exceeded", "semantic frame body exceeds the v1 4 MiB limit");
  }
}

const SEMANTIC_FRAME_KINDS = new Set([
  "tenant",
  "do.descriptor",
  "do.sqlite.schema",
  "do.sqlite.rows",
  "do.sqlite.cell",
  "do.kv",
  "r2.descriptor",
  "r2.body",
  "workers-kv.descriptor",
  "workers-kv.value",
]);

function validateSemanticIdentifier(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("invalid_value", "semantic objectId is invalid");
  }
  assertValidUnicode(value);
  if (textEncoder.encode(value).byteLength > 1024) {
    fail("invalid_value", "semantic objectId exceeds 1024 UTF-8 bytes");
  }
}
