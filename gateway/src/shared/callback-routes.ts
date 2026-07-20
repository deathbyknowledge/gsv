import { canonicalizeLoginUsername } from "../auth/login";

const ROUTED_OAUTH_STATE_PREFIX = "gsv1o";
const MAX_ROUTED_OAUTH_STATE_LENGTH = 512;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const FLOW_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type RoutedOAuthState = {
  username: string;
  generation: number;
  flowId: string;
};

export function buildRoutedOAuthState(
  usernameInput: string,
  generation: number,
  flowId: string,
  opaqueToken: string,
): string {
  const username = canonicalizeLoginUsername(usernameInput);
  if (
    !username
    || username !== usernameInput
    || !Number.isSafeInteger(generation)
    || generation <= 0
    || !FLOW_ID_RE.test(flowId)
    || !OPAQUE_TOKEN_RE.test(opaqueToken)
  ) {
    throw new Error("Invalid routed OAuth state");
  }
  return `${ROUTED_OAUTH_STATE_PREFIX}~${username}~${generation}~${flowId}~${opaqueToken}`;
}

export function parseRoutedOAuthState(value: unknown): RoutedOAuthState | null {
  if (typeof value !== "string" || value.length > MAX_ROUTED_OAUTH_STATE_LENGTH) {
    return null;
  }
  const [prefix, rawUsername, rawGeneration, flowId, opaqueToken, extra] = value.split("~");
  const username = canonicalizeLoginUsername(rawUsername);
  const generation = Number(rawGeneration);
  if (
    prefix !== ROUTED_OAUTH_STATE_PREFIX
    || extra !== undefined
    || !username
    || username !== rawUsername
    || !Number.isSafeInteger(generation)
    || generation <= 0
    || !FLOW_ID_RE.test(flowId ?? "")
    || !OPAQUE_TOKEN_RE.test(opaqueToken ?? "")
  ) {
    return null;
  }
  return { username, generation, flowId: flowId! };
}

export function buildUserMcpOAuthCallbackPath(
  usernameInput: string,
  generation: number,
): string {
  const username = canonicalizeLoginUsername(usernameInput);
  if (
    !username
    || username !== usernameInput
    || !Number.isSafeInteger(generation)
    || generation <= 0
  ) {
    throw new Error("Invalid MCP OAuth callback route");
  }
  return `/oauth/callback/${username}/${generation}`;
}

export function matchUserMcpOAuthCallbackPath(pathname: string): {
  username: string;
  generation: number;
} | null {
  const match = /^\/oauth\/callback\/([^/]+)\/(\d{1,10})$/.exec(pathname);
  if (!match) return null;
  const username = canonicalizeLoginUsername(match[1]);
  const generation = Number(match[2]);
  if (
    !username
    || username !== match[1]
    || !Number.isSafeInteger(generation)
    || generation <= 0
  ) {
    return null;
  }
  return { username, generation };
}
