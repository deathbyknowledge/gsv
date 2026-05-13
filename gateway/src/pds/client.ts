import type {
  SpaceGsvCollection,
  SpaceGsvRecord,
} from "@gsv/protocol/syscalls/social";
import { devHandleForOrigin } from "../dev";

type QueryValue = string | number | boolean | null | undefined;

export type PdsXrpcJsonInput = {
  host: string;
  method: string;
  httpMethod?: string;
  params?: Record<string, QueryValue>;
  body?: unknown;
  admin?: boolean;
};

export type PdsRecordResponse<TRecord = SpaceGsvRecord> = {
  uri: string;
  cid: string;
  value: TRecord;
};

export type PdsListRecordsResponse<TRecord = SpaceGsvRecord> = {
  cursor?: string;
  records: PdsRecordResponse<TRecord>[];
};

export type PdsCommitRef = {
  cid: string;
  rev: string;
};

export type PdsRecordMutationResponse = {
  uri?: string;
  cid?: string;
  commit?: PdsCommitRef;
  validationStatus?: string;
};

export type PdsCreateRecordInput<TRecord = SpaceGsvRecord> = {
  host: string;
  repo: string;
  collection: SpaceGsvCollection;
  record: TRecord;
  rkey?: string;
  validate?: boolean;
  swapCommit?: string | null;
};

export type PdsPutRecordInput<TRecord = SpaceGsvRecord> = PdsCreateRecordInput<TRecord> & {
  rkey: string;
  swapRecord?: string | null;
};

export type PdsDeleteRecordInput = {
  host: string;
  repo: string;
  collection: SpaceGsvCollection;
  rkey: string;
  swapRecord?: string | null;
  swapCommit?: string | null;
};

export type PdsApplyWritesInput = {
  host: string;
  repo: string;
  writes: unknown[];
  validate?: boolean;
  swapCommit?: string | null;
};

export type PdsCreateAccountInput = {
  host: string;
  handle: string;
  password: string;
  email?: string;
  inviteCode?: string;
  did?: string;
  signingKey?: string;
};

export type PdsEnsureAccountInput = PdsCreateAccountInput;

export type PdsEnsureAccountResponse = {
  did: string;
  handle: string;
  created: boolean;
};

export type PdsCreateAccountInputLegacy = {
  host: string;
  handle: string;
  password?: string;
  email?: string;
  inviteCode?: string;
  did?: string;
  signingKey?: string;
};

export type PdsServiceBinding = Fetcher & {
  pdsXrpcJson(input: PdsXrpcJsonInput): Promise<unknown>;
  pdsDescribeServer(input: { host: string }): Promise<unknown>;
  pdsResolveHandle(input: { host: string; handle: string }): Promise<unknown>;
  pdsDescribeRepo(input: { host: string; repo: string }): Promise<unknown>;
  pdsGetLatestCommit(input: { host: string; did: string }): Promise<unknown>;
  pdsListRepos(input: { host: string; limit?: number; cursor?: string }): Promise<unknown>;
  pdsGetRecord(input: {
    host: string;
    repo: string;
    collection: string;
    rkey: string;
  }): Promise<unknown>;
  pdsListRecords(input: {
    host: string;
    repo: string;
    collection: string;
    limit?: number;
    cursor?: string;
    reverse?: boolean;
  }): Promise<unknown>;
  pdsCreateRecord(input: PdsCreateRecordInput): Promise<unknown>;
  pdsPutRecord(input: PdsPutRecordInput): Promise<unknown>;
  pdsDeleteRecord(input: PdsDeleteRecordInput): Promise<unknown>;
  pdsApplyWrites(input: PdsApplyWritesInput): Promise<unknown>;
  pdsCreateAccount(input: PdsCreateAccountInputLegacy): Promise<unknown>;
  pdsEnsureAccount(input: PdsEnsureAccountInput): Promise<unknown>;
};

export class PdsClient {
  constructor(private readonly binding: PdsServiceBinding) {}

  fetch(request: Request): Promise<Response> {
    return this.binding.fetch(request);
  }

  fetchXrpc(request: Request): Promise<Response> {
    return this.fetch(request);
  }

  describeServer(host: string): Promise<unknown> {
    return this.binding.pdsDescribeServer({ host });
  }

  resolveHandle(host: string, handle: string): Promise<unknown> {
    return this.binding.pdsResolveHandle({ host, handle });
  }

  describeRepo(host: string, repo: string): Promise<unknown> {
    return this.binding.pdsDescribeRepo({ host, repo });
  }

  getLatestCommit(host: string, did: string): Promise<unknown> {
    return this.binding.pdsGetLatestCommit({ host, did });
  }

  listRepos(host: string, options: { limit?: number; cursor?: string } = {}): Promise<unknown> {
    return this.binding.pdsListRepos({ host, ...options });
  }

  async getRecord<TRecord = SpaceGsvRecord>(input: {
    host: string;
    repo: string;
    collection: SpaceGsvCollection;
    rkey: string;
  }): Promise<PdsRecordResponse<TRecord>> {
    return assertRecordResponse<TRecord>(
      await this.binding.pdsGetRecord(input),
      "PDS getRecord",
    );
  }

  async listRecords<TRecord = SpaceGsvRecord>(input: {
    host: string;
    repo: string;
    collection: SpaceGsvCollection;
    limit?: number;
    cursor?: string;
    reverse?: boolean;
  }): Promise<PdsListRecordsResponse<TRecord>> {
    return assertListRecordsResponse<TRecord>(
      await this.binding.pdsListRecords(input),
      "PDS listRecords",
    );
  }

  async createRecord<TRecord extends SpaceGsvRecord>(
    input: PdsCreateRecordInput<TRecord>,
  ): Promise<PdsRecordMutationResponse> {
    return assertRecordMutationResponse(
      await this.binding.pdsCreateRecord(input),
      "PDS createRecord",
    );
  }

  async putRecord<TRecord extends SpaceGsvRecord>(
    input: PdsPutRecordInput<TRecord>,
  ): Promise<PdsRecordMutationResponse> {
    return assertRecordMutationResponse(
      await this.binding.pdsPutRecord(input),
      "PDS putRecord",
    );
  }

  async deleteRecord(input: PdsDeleteRecordInput): Promise<PdsRecordMutationResponse> {
    return assertRecordMutationResponse(
      await this.binding.pdsDeleteRecord(input),
      "PDS deleteRecord",
    );
  }

  applyWrites(input: PdsApplyWritesInput): Promise<unknown> {
    return this.binding.pdsApplyWrites(input);
  }

  createAccount(input: PdsCreateAccountInputLegacy): Promise<unknown> {
    return this.binding.pdsCreateAccount(input);
  }

  async ensureAccount(input: PdsEnsureAccountInput): Promise<PdsEnsureAccountResponse> {
    const object = requireObject(await this.binding.pdsEnsureAccount(input), "PDS ensureAccount");
    if (typeof object.did !== "string" || typeof object.handle !== "string" || typeof object.created !== "boolean") {
      throw new Error("PDS ensureAccount returned an invalid response");
    }
    return {
      did: object.did,
      handle: object.handle,
      created: object.created,
    };
  }
}

export function requirePdsClient(env: Env): PdsClient {
  const binding = (env as unknown as { PDS?: PdsServiceBinding }).PDS;
  if (!binding) {
    throw new Error("PDS binding is required");
  }
  return new PdsClient(binding);
}

export async function proxyPdsXrpcRequest(request: Request, env: Env): Promise<Response> {
  return requirePdsClient(env).fetchXrpc(rewriteDevPdsProxyRequest(request, env));
}

export async function proxyPdsRequest(request: Request, env: Env): Promise<Response> {
  return requirePdsClient(env).fetch(rewriteDevPdsProxyRequest(request, env));
}

function rewriteDevPdsProxyRequest(request: Request, env: Env): Request {
  const source = new URL(request.url);
  const handle = devHandleForOrigin(env, source.origin);
  if (!handle) {
    return request;
  }
  source.protocol = "https:";
  source.hostname = handle;
  source.port = "";
  return new Request(source.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: request.redirect,
  });
}

function assertRecordResponse<TRecord>(value: unknown, label: string): PdsRecordResponse<TRecord> {
  const object = requireObject(value, label);
  if (typeof object.uri !== "string" || typeof object.cid !== "string" || !("value" in object)) {
    throw new Error(`${label} returned an invalid record response`);
  }
  return {
    uri: object.uri,
    cid: object.cid,
    value: object.value as TRecord,
  };
}

function assertListRecordsResponse<TRecord>(
  value: unknown,
  label: string,
): PdsListRecordsResponse<TRecord> {
  const object = requireObject(value, label);
  if (!Array.isArray(object.records)) {
    throw new Error(`${label} returned an invalid list response`);
  }
  return {
    cursor: typeof object.cursor === "string" ? object.cursor : undefined,
    records: object.records.map((record, index) =>
      assertRecordResponse<TRecord>(record, `${label} record ${index}`)),
  };
}

function assertRecordMutationResponse(value: unknown, label: string): PdsRecordMutationResponse {
  const object = requireObject(value, label);
  if (typeof object.uri !== "string" && !isCommitRef(object.commit)) {
    throw new Error(`${label} returned an invalid mutation response`);
  }
  const commit = isCommitRef(object.commit) ? object.commit : undefined;
  return {
    uri: typeof object.uri === "string" ? object.uri : undefined,
    cid: typeof object.cid === "string" ? object.cid : undefined,
    commit,
    validationStatus: typeof object.validationStatus === "string"
      ? object.validationStatus
      : undefined,
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned a non-object response`);
  }
  return value as Record<string, unknown>;
}

function isCommitRef(value: unknown): value is PdsCommitRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const commit = value as Record<string, unknown>;
  return typeof commit.cid === "string" && typeof commit.rev === "string";
}
