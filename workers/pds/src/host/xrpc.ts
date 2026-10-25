import { isDid } from "@atcute/lexicons/syntax";
import * as z from "zod/mini";
import type { AccountStatus } from "../cirrus/repo/sequencer";
import type { HostEnv } from "./env";
import { FIREHOSE_NAME } from "./firehose";

export const XRPC_PREFIX = "/xrpc/";

/** Whether the deployment serves a repository's public data, by the name of the object that holds it. */
export type Admission = "active" | AccountStatus;

/** XRPC reads a hosted repository serves, with the parameter that names the repository. */
const REPOSITORY_METHODS = new Map<string, "repo" | "did">([
  ["com.atproto.repo.describeRepo", "repo"],
  ["com.atproto.repo.getRecord", "repo"],
  ["com.atproto.repo.listRecords", "repo"],
  ["com.atproto.sync.getBlob", "did"],
  ["com.atproto.sync.getBlocks", "did"],
  ["com.atproto.sync.getLatestCommit", "did"],
  ["com.atproto.sync.getRecord", "did"],
  ["com.atproto.sync.getRepo", "did"],
  ["com.atproto.sync.getRepoStatus", "did"],
  ["com.atproto.sync.listBlobs", "did"],
]);

const STATUS_ERRORS = {
  deactivated: "RepoDeactivated",
  deleted: "RepoNotFound",
  suspended: "RepoSuspended",
  takendown: "RepoTakendown",
} satisfies Record<AccountStatus, string>;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const listReposQuery = z.object({
  limit: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(1000)), 500),
  cursor: z.optional(z.string()),
});

/** A failure an XRPC method reports by name. */
export class XrpcError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }

  response(): Response {
    return Response.json({ error: this.error, message: this.message }, { status: this.status });
  }
}

/** The parameter that names the repository a read addresses, or null for a method no repository serves. */
export function repositoryParameter(method: string): "repo" | "did" | null {
  return REPOSITORY_METHODS.get(method) ?? null;
}

/** Parses an XRPC method's query parameters, reporting InvalidRequest when they do not match. */
export function parseQuery<T extends z.ZodMiniType>(schema: T, url: URL): z.output<T> {
  const parsed = z.safeParse(schema, Object.fromEntries(url.searchParams));
  if (!parsed.success) throw new XrpcError("InvalidRequest", z.prettifyError(parsed.error));
  return parsed.data;
}

/**
 * Serves a host's public XRPC reads. Host methods answer here; a repository
 * read goes to the object that holds the repository, once the host directory
 * finds it and the deployment admits it, so an unknown DID never addresses an
 * object.
 */
export async function handleXrpc(
  request: Request,
  env: HostEnv,
  admit: (name: string) => Promise<Admission>,
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(request.url);
  if (!url.pathname.startsWith(XRPC_PREFIX)) return withCors(new XrpcError("NotFound", "Not found", 404).response());
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(new XrpcError("InvalidRequest", "Only queries are served here", 405).response());
  }
  if (url.pathname === `${XRPC_PREFIX}com.atproto.sync.subscribeRepos`) {
    return env.FIREHOSE.getByName(FIREHOSE_NAME).fetch(request);
  }
  try {
    return withCors(await serveQuery(request, env, admit));
  } catch (error) {
    if (error instanceof XrpcError) return withCors(error.response());
    throw error;
  }
}

/** com.atproto.server.describeServer's output; the operator's links and contact appear when the deployment gives them. */
type ServerDescription = {
  did: string;
  availableUserDomains: string[];
  inviteCodeRequired: boolean;
  links?: { privacyPolicy?: string; termsOfService?: string };
  contact?: { email: string };
};

async function serveQuery(request: Request, env: HostEnv, admit: (name: string) => Promise<Admission>): Promise<Response> {
  const url = new URL(request.url);
  const method = url.pathname.slice(XRPC_PREFIX.length);
  const firehose = env.FIREHOSE.getByName(FIREHOSE_NAME);
  switch (method) {
    case "_health":
      return Response.json({ version: "gsv-pds" });
    case "com.atproto.server.describeServer": {
      const server: ServerDescription = { did: `did:web:${url.hostname}`, availableUserDomains: [], inviteCodeRequired: true };
      if (env.PDS_PRIVACY_POLICY_URL || env.PDS_TERMS_OF_SERVICE_URL) {
        server.links = { privacyPolicy: env.PDS_PRIVACY_POLICY_URL, termsOfService: env.PDS_TERMS_OF_SERVICE_URL };
      }
      if (env.PDS_CONTACT_EMAIL) server.contact = { email: env.PDS_CONTACT_EMAIL };
      return Response.json(server);
    }
    case "com.atproto.sync.listRepos": {
      const query = parseQuery(listReposQuery, url);
      const { repos, cursor } = await firehose.listRepos(query.limit, query.cursor);
      return Response.json({
        repos: repos.map((repo) => ({
          did: repo.did,
          head: repo.head,
          rev: repo.rev,
          active: repo.active,
          status: repo.status ?? undefined,
        })),
        cursor,
      });
    }
  }
  const parameter = repositoryParameter(method);
  if (!parameter) throw new XrpcError("MethodNotImplemented", `Method not implemented: ${method}`, 501);
  const identifier = url.searchParams.get(parameter);
  if (!identifier) throw new XrpcError("InvalidRequest", `Missing parameter ${parameter}`);
  if (parameter === "did" && !isDid(identifier)) throw new XrpcError("InvalidRequest", `${identifier} is not a DID`);
  const entry = await firehose.locate(identifier);
  if (!entry) throw new XrpcError("RepoNotFound", `Could not find repo: ${identifier}`);
  const admission = await admit(entry.name);
  if (admission === "active") return env.REPOS.getByName(entry.name).fetch(request);
  if (method === "com.atproto.sync.getRepoStatus") return Response.json({ did: entry.did, active: false, status: admission });
  throw new XrpcError(STATUS_ERRORS[admission], `Repo is ${admission}: ${entry.did}`);
}

function withCors(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("Access-Control-Allow-Origin", "*");
  return copy;
}
