export const PORTABLE_ARCHIVE_VERSION = 1 as const;
export const NORMALIZATION_POLICY_VERSION = 1 as const;

export const OUTER_MAGIC = new Uint8Array([
  0x47, 0x53, 0x56, 0x50, 0x41, 0x00, 0x01, 0x0a,
]);
export const INNER_MAGIC = new Uint8Array([
  0x47, 0x53, 0x56, 0x49, 0x00, 0x01, 0x0a,
]);
export const TRAILER_MAGIC = new Uint8Array([0x47, 0x53, 0x56, 0x54]);

export const SHA256_BYTES = 32;
export const AES_256_KEY_BYTES = 32;
export const GCM_NONCE_PREFIX_BYTES = 8;
export const GCM_TAG_BYTES = 16;

export const DEFAULT_PLAINTEXT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_PLAINTEXT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_FRAME_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_FRAME_HEADER_BYTES = 64 * 1024;
export const DEFAULT_MAX_ENVELOPE_BYTES = 64 * 1024;
export const DEFAULT_MAX_FRAMES = 10_000_000;
export const DEFAULT_MAX_TOTAL_BODY_BYTES = 8n * 1024n * 1024n * 1024n * 1024n;

export const FINAL_CHUNK_FLAG = 0x01;
export const KNOWN_CHUNK_FLAGS = FINAL_CHUNK_FLAG;

export const ZERO_SHA256: Uint8Array = new Uint8Array(SHA256_BYTES);

export const PASSPHRASE_SCRYPT_PARAMETERS = Object.freeze({
  N: 131072 as const,
  r: 8,
  p: 1,
} as const);
