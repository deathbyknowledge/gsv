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

/**
 * This Ship's host took its account down, so it signs no call to another Ship
 * until the operator restores it. Nothing waiting can be sent before then.
 */
export class ShipTakenDownError extends Error {
  constructor(options?: ErrorOptions) {
    super("Your Ship is taken down on the open network, so it can't reach other Ships", options);
    this.name = "ShipTakenDownError";
  }
}

/** Another Ship refused a call; `error` is the XRPC error it named, if any. */
export class ShipCallError extends FederationHttpError {
  constructor(status: number, readonly error: string | undefined, message: string) {
    super(status, message);
    this.name = "ShipCallError";
  }
}
