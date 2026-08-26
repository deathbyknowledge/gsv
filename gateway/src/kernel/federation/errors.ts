export class FederationHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FederationHttpError";
  }
}

export class PublicFederationError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PublicFederationError";
  }
}
