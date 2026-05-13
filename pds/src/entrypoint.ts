import RustWorker, { PdsDirectoryObject, RepoObject } from "../build/index.js";

export { PdsDirectoryObject, RepoObject };

type JsonBody = unknown;

type QueryValue = string | number | boolean | null | undefined;

type QueryParams = Record<string, QueryValue>;

type PdsEntrypointEnv = {
  PDS_ADMIN_TOKEN?: string;
};

type XrpcJsonInput = {
  host: string;
  method: string;
  httpMethod?: string;
  params?: QueryParams;
  body?: JsonBody;
  admin?: boolean;
};

type XrpcJsonResult = {
  status: number;
  ok: boolean;
  payload: unknown;
};

type RepoRecordInput = {
  host: string;
  repo: string;
  collection: string;
  rkey: string;
};

type RepoListRecordsInput = {
  host: string;
  repo: string;
  collection: string;
  limit?: number;
  cursor?: string;
  reverse?: boolean;
};

type RepoCreateRecordInput = {
  host: string;
  repo: string;
  collection: string;
  record: JsonBody;
  rkey?: string;
  validate?: boolean;
  swapCommit?: string | null;
};

type RepoPutRecordInput = RepoCreateRecordInput & {
  rkey: string;
  swapRecord?: string | null;
};

type RepoDeleteRecordInput = {
  host: string;
  repo: string;
  collection: string;
  rkey: string;
  swapRecord?: string | null;
  swapCommit?: string | null;
};

type RepoApplyWritesInput = {
  host: string;
  repo: string;
  writes: JsonBody[];
  validate?: boolean;
  swapCommit?: string | null;
};

export default class GsvPdsEntrypoint extends RustWorker {
  async pdsXrpcJson(input: XrpcJsonInput): Promise<unknown> {
    return this.xrpcJson(input);
  }

  async pdsDescribeServer(input: { host: string }): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.server.describeServer",
    });
  }

  async pdsResolveHandle(input: { host: string; handle: string }): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.identity.resolveHandle",
      params: { handle: input.handle },
    });
  }

  async pdsDescribeRepo(input: { host: string; repo: string }): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.repo.describeRepo",
      params: { repo: input.repo },
    });
  }

  async pdsGetLatestCommit(input: { host: string; did: string }): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.sync.getLatestCommit",
      params: { did: input.did },
    });
  }

  async pdsListRepos(input: { host: string; limit?: number; cursor?: string }): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.sync.listRepos",
      params: {
        limit: input.limit,
        cursor: input.cursor,
      },
    });
  }

  async pdsGetRecord(input: RepoRecordInput): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.repo.getRecord",
      params: {
        repo: input.repo,
        collection: input.collection,
        rkey: input.rkey,
      },
    });
  }

  async pdsListRecords(input: RepoListRecordsInput): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.repo.listRecords",
      params: {
        repo: input.repo,
        collection: input.collection,
        limit: input.limit,
        cursor: input.cursor,
        reverse: input.reverse,
      },
    });
  }

  async pdsCreateRecord(input: RepoCreateRecordInput): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.repo.createRecord",
      httpMethod: "POST",
      body: {
        repo: input.repo,
        collection: input.collection,
        record: input.record,
        rkey: input.rkey,
        validate: input.validate,
        swapCommit: input.swapCommit,
      },
      admin: true,
    });
  }

  async pdsPutRecord(input: RepoPutRecordInput): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.repo.putRecord",
      httpMethod: "POST",
      body: {
        repo: input.repo,
        collection: input.collection,
        rkey: input.rkey,
        record: input.record,
        validate: input.validate,
        swapRecord: input.swapRecord,
        swapCommit: input.swapCommit,
      },
      admin: true,
    });
  }

  async pdsDeleteRecord(input: RepoDeleteRecordInput): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.repo.deleteRecord",
      httpMethod: "POST",
      body: {
        repo: input.repo,
        collection: input.collection,
        rkey: input.rkey,
        swapRecord: input.swapRecord,
        swapCommit: input.swapCommit,
      },
      admin: true,
    });
  }

  async pdsApplyWrites(input: RepoApplyWritesInput): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.repo.applyWrites",
      httpMethod: "POST",
      body: {
        repo: input.repo,
        writes: input.writes,
        validate: input.validate,
        swapCommit: input.swapCommit,
      },
      admin: true,
    });
  }

  async pdsCreateAccount(input: {
    host: string;
    handle: string;
    password?: string;
    email?: string;
    inviteCode?: string;
    did?: string;
    signingKey?: string;
  }): Promise<unknown> {
    return this.xrpcJson({
      host: input.host,
      method: "com.atproto.server.createAccount",
      httpMethod: "POST",
      body: {
        handle: input.handle,
        password: input.password,
        email: input.email,
        inviteCode: input.inviteCode,
        did: input.did,
        signingKey: input.signingKey,
      },
      admin: true,
    });
  }

  async pdsEnsureAccount(input: {
    host: string;
    handle: string;
    password: string;
    email?: string;
    inviteCode?: string;
    did?: string;
    signingKey?: string;
  }): Promise<unknown> {
    const created = await this.xrpcJsonResult({
      host: input.host,
      method: "com.atproto.server.createAccount",
      httpMethod: "POST",
      body: {
        handle: input.handle,
        password: input.password,
        email: input.email,
        inviteCode: input.inviteCode,
        did: input.did,
        signingKey: input.signingKey,
      },
      admin: true,
    });

    if (created.ok) {
      return {
        ...requireObjectPayload(created.payload, "createAccount"),
        created: true,
      };
    }

    if (!isExistingAccountResponse(created.status, created.payload)) {
      throw new Error(
        `PDS XRPC com.atproto.server.createAccount failed status=${created.status}: ${formatErrorPayload(created.payload)}`,
      );
    }

    const resolved = await this.xrpcJson({
      host: input.host,
      method: "com.atproto.identity.resolveHandle",
      params: { handle: input.handle },
    });
    const resolvedObject = requireObjectPayload(resolved, "resolveHandle");
    const did = requirePayloadString(resolvedObject.did, "resolveHandle.did");
    if (input.did && did !== input.did) {
      throw new Error(`existing PDS account for ${input.handle} resolved to ${did}, expected ${input.did}`);
    }
    return {
      did,
      handle: input.handle,
      created: false,
    };
  }

  private async xrpcJson(input: XrpcJsonInput): Promise<unknown> {
    const result = await this.xrpcJsonResult(input);
    if (!result.ok) {
      const method = requireNonEmptyString(input.method, "method");
      throw new Error(
        `PDS XRPC ${method} failed status=${result.status}: ${formatErrorPayload(result.payload)}`,
      );
    }
    return result.payload;
  }

  private async xrpcJsonResult(input: XrpcJsonInput): Promise<XrpcJsonResult> {
    const method = requireNonEmptyString(input.method, "method");
    const host = normalizeHost(requireNonEmptyString(input.host, "host"));
    const httpMethod = input.httpMethod ?? (input.body === undefined ? "GET" : "POST");
    const url = new URL(`https://${host}/xrpc/${encodeURIComponent(method)}`);
    appendQueryParams(url, input.params);

    const headers = new Headers();
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (input.admin) {
      const token = this.adminToken();
      if (!token) {
        throw new Error("PDS_ADMIN_TOKEN binding is required for admin PDS RPC methods");
      }
      headers.set("x-pds-admin-token", token);
    }

    const request = new Request(url.toString(), {
      method: httpMethod,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(stripUndefined(input.body)),
    });
    const response = await super.fetch(request);
    const payload = await parseResponseBody(response);
    return {
      status: response.status,
      ok: response.ok,
      payload,
    };
  }

  private adminToken(): string | undefined {
    const env = (this as unknown as { env?: PdsEntrypointEnv }).env;
    const token = env?.PDS_ADMIN_TOKEN?.trim();
    return token || undefined;
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function normalizeHost(host: string): string {
  const parsed = host.replace(/^https?:\/\//, "").split("/")[0]?.trim().toLowerCase() ?? "";
  if (!parsed) {
    throw new Error("host is required");
  }
  return parsed;
}

function appendQueryParams(url: URL, params: QueryParams | undefined): void {
  if (!params) {
    return;
  }
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function stripUndefined(value: JsonBody): JsonBody {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, JsonBody> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = stripUndefined(item);
    }
  }
  return output;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function formatErrorPayload(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function requireObjectPayload(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned a non-object payload`);
  }
  return value as Record<string, unknown>;
}

function requirePayloadString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function isExistingAccountResponse(status: number, payload: unknown): boolean {
  const error = requireMaybeError(payload);
  return (
    (status === 400 && (error.includes("HandleNotAvailable") || error.includes("DidNotAvailable"))) ||
    (status === 409 && error.includes("repo already initialized"))
  );
}

function requireMaybeError(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" ? error : "";
}
