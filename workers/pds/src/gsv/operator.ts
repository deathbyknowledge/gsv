import * as z from "zod/mini";
import { parseQuery, XrpcError } from "../host/xrpc";
import type { PdsEnv } from "./env";
import { AUDIT_PAGE, AUDIT_READS_PER_SECOND, auditIdentities, MAX_AUDIT_READS_PER_SECOND } from "./identity-audit";
import { createLexiconAccount, lexiconAccount, publishLexicons } from "./lexicons";
import { OperatorTokenError, verifyOperatorToken, type OperatorClaims } from "./operator-token";

/** Where the operator's command sends its requests, outside the host's XRPC methods. */
export const OPERATOR_PATH = "/operator/lexicons";

/** Where the operator's identity audit sends its requests, a page of identities each. */
export const IDENTITY_AUDIT_PATH = "/operator/identities";

const auditQuery = z.object({
  limit: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(AUDIT_PAGE)), AUDIT_PAGE),
  readsPerSecond: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(MAX_AUDIT_READS_PER_SECOND)), AUDIT_READS_PER_SECOND),
  cursor: z.optional(z.string()),
});

/**
 * Serves the operator's requests about the deployment's lexicon account. Each
 * is a POST with a token the host's rotation key signed for this host, which
 * names what to do: report the account, create it for the handle the token
 * names, or publish this release's lexicons. A token for an audit opens only
 * the identity audit, which reads every hosted identity's log again.
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
        return Response.json(await auditIdentities(env, parseQuery(auditQuery, url)));
    }
  } catch (error) {
    if (error instanceof XrpcError) return error.response();
    throw error;
  }
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
