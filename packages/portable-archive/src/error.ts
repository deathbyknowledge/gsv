export type PortableArchiveErrorCode =
  | "invalid_argument"
  | "invalid_magic"
  | "invalid_envelope"
  | "invalid_frame"
  | "invalid_manifest"
  | "invalid_trailer"
  | "invalid_value"
  | "integrity_error"
  | "limit_exceeded"
  | "noncanonical_json"
  | "trailing_data"
  | "truncated_archive"
  | "unsupported_feature";

export class PortableArchiveError extends Error {
  readonly code: PortableArchiveErrorCode;

  constructor(code: PortableArchiveErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortableArchiveError";
    this.code = code;
  }
}

export function fail(
  code: PortableArchiveErrorCode,
  message: string,
): never {
  throw new PortableArchiveError(code, message);
}
