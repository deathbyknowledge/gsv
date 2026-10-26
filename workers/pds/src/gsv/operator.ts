import { XrpcError } from "../host/xrpc";
import type { PdsEnv } from "./env";
import { createLexiconAccount, lexiconAccount, publishLexicons } from "./lexicons";
import { OperatorTokenError, verifyOperatorToken, type OperatorClaims } from "./operator-token";

/** Where the operator's command sends its requests, outside the host's XRPC methods. */
export const OPERATOR_PATH = "/operator/lexicons";

/**
 * Serves the operator's requests about the deployment's lexicon account. Each
 * is a POST with a token the host's rotation key signed for this host, which
 * names what to do: report the account, create it for the handle the token
 * names, or publish this release's lexicons.
 */
export async function handleOperator(request: Request, env: PdsEnv): Promise<Response> {
  try {
    if (request.method !== "POST") throw new XrpcError("InvalidRequest", "Operator requests are POSTs", 405);
    const claims = await authorize(request, env);
    switch (claims.act) {
      case "status":
        return Response.json(await lexiconAccount(env));
      case "create":
        return Response.json(await createLexiconAccount(env, claims.handle ?? ""));
      case "publish": {
        const published = await publishLexicons(env);
        return Response.json({ ...await lexiconAccount(env), published });
      }
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
