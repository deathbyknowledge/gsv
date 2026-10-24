import { FederationHttpError } from "../federation/errors";

/** An XRPC error this Ship answers a call with: `{ error, message }` under an HTTP status. */
export class ShipXrpcError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ShipXrpcError";
  }
}

/** Another Ship refused a call; `error` is the XRPC error it named, if any. */
export class ShipCallError extends FederationHttpError {
  constructor(status: number, readonly error: string | undefined, message: string) {
    super(status, message);
    this.name = "ShipCallError";
  }
}
