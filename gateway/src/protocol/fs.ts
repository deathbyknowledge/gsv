/**
 * Filesystem (R2) access protocol.
 *
 * Clients request short-lived tokens via the `fs.authorize` RPC over WebSocket.
 * The token is then used as a Bearer header on HTTP requests to `/fs/{r2-key}`.
 * The worker fetch handler validates the token against the Gateway DO before
 * proxying the R2 read/write.
 */

export type FsMode = "read" | "write";

export type FsAuthorizeParams = {
  /** R2 key prefix this token grants access to (e.g. "browser-profiles/github.com/") */
  pathPrefix: string;
  /** read = GET, write = PUT */
  mode: FsMode;
};

export type FsAuthorizeResult = {
  /** Opaque token to use as Bearer header */
  token: string;
  /** When this token expires (unix ms) */
  expiresAt: number;
  /** The /fs/ URL path prefix to use */
  pathPrefix: string;
};

/** Internal token record stored in Gateway DO memory. */
export type FsToken = {
  pathPrefix: string;
  mode: FsMode;
  expiresAt: number;
};
