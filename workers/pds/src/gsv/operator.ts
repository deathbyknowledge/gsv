import * as z from "zod/mini";
import { FIREHOSE_NAME } from "../host/firehose";
import type { IdentityFeed } from "../host/identity-feed";
import type { IdentityFollow } from "../host/repo";
import { parseQuery, XrpcError } from "../host/xrpc";
import type { PdsEnv } from "./env";
import { createLexiconAccount, lexiconAccount, publishLexicons } from "./lexicons";
import { OperatorTokenError, verifyOperatorToken, type OperatorClaims } from "./operator-token";

/** Where the operator's command sends its requests, outside the host's XRPC methods. */
export const OPERATOR_PATH = "/operator/lexicons";

/** Where the operator's identity audit sends its requests. */
export const IDENTITY_AUDIT_PATH = "/operator/identities";

const auditQuery = z.object({ did: z.optional(z.string().check(z.startsWith("did:"))) });

/**
 * Serves the operator's requests about the deployment's lexicon account. Each
 * is a POST with a token the host's rotation key signed for this host, which
 * names what to do: report the account, create it for the handle the token
 * names, or publish this release's lexicons. A token for an audit opens only
 * the identity audit, which reports what the host's reading of the PLC
 * directory's feed has found, or reads one hosted identity's log again.
 */
export async function handleOperator(request: Request, env: PdsEnv): Promise<Response> {
  try {
    if (request.method !== "POST") throw new XrpcError("InvalidRequest", "Operator requests are POSTs", 405);
    const claims = await authorize(request, env);
    const url = new URL(request.url);
    if ((url.pathname === IDENTITY_AUDIT_PATH) !== (claims.act === "audit")) {
      throw new XrpcError("InvalidToken", "The token is for another operator request", 401);
    }
    switch (claims.act) {
      case "status":
        return Response.json(await lexiconAccount(env));
      case "create":
        return Response.json(await createLexiconAccount(env, claims.handle ?? ""));
      case "publish": {
        const published = await publishLexicons(env);
        return Response.json({ ...await lexiconAccount(env), published });
      }
      case "audit":
        return Response.json(await auditIdentities(env, parseQuery(auditQuery, url).did));
    }
  } catch (error) {
    if (error instanceof XrpcError) return error.response();
    throw error;
  }
}

/** What the feed has found among the identities the host holds or, given a DID, what reading that one's log again finds. */
async function auditIdentities(env: PdsEnv, did: string | undefined): Promise<IdentityFeed | IdentityFollow> {
  const firehose = env.FIREHOSE.getByName(FIREHOSE_NAME);
  if (did === undefined) return firehose.identityFeed();
  const hosted = await firehose.locate(did);
  const followed = hosted && await env.REPOS.getByName(hosted.name).followIdentity();
  if (!followed) throw new XrpcError("RepoNotFound", `Could not find repo: ${did}`);
  return followed;
}

async function authorize(request: Request, env: PdsEnv): Promise<OperatorClaims> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new XrpcError("AuthenticationRequired", "An operator token is required", 401);
  try {
    return await verifyOperatorToken(env.PLC_ROTATION_KEY, token, env.PDS_ORIGIN);
  } catch (error) {
    if (error instanceof OperatorTokenError) throw new XrpcError("InvalidToken", error.message, 401);
    throw error;
  }
}
