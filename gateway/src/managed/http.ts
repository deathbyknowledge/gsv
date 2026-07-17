import { getAgentByName } from "agents";
import { authorizeManagedAdmin } from "../auth/managed-admin";
import {
  SetupTokenPolicyValidationError,
  parseSetupTokenPolicy,
  type SetupTokenPolicy,
} from "../auth/setup-token-policy";
import { SERVER_RELEASE } from "../version";
import {
  describeGatewayManagedObjects,
  isGatewayManagedObjectKind,
  ManagedProviderIdError,
  type GatewayManagedObjectKind,
} from "./objects";
import {
  DATA_FRAME_STREAM_CONTROL_KIND,
  DATA_FRAME_STREAM_MAX_RESTORE_CONTROL_BYTES,
  DATA_FRAME_STREAM_MEDIA_TYPE,
  MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
  decodeDataFrameStream,
  decodeManagedRestoreControl,
  encodeDataFrameStream,
  encodeManagedRestoreControl,
  normalizeManagedProviderIds,
  validateManagedSnapshotRequest,
  validateManagedObjectDescriptor,
  type DataFrameStreamRecord,
  type ManagedObjectRestoreControl,
  type ManagedObjectSnapshotRequest,
  type ManagedObjectDescriptorBatch,
  type ManagedObjectKind,
} from "@humansandmachines/gsv/protocol";

export const MANAGED_ROUTE_PREFIX = "/__gsv/managed/v1";
const MAX_SETUP_TOKEN_POLICY_BODY_BYTES = 1_024;
const MAX_MANAGED_OBJECT_DESCRIPTOR_BODY_BYTES = 80 * 1_024;
const MAX_MANAGED_DESCRIPTOR_RESPONSE_BYTES = 1024 * 1024;
const MAX_ADAPTER_ACCOUNTS_PER_LIFECYCLE_CALL = 1_000;
const MAX_MANAGED_SNAPSHOT_REQUEST_BYTES = 16 * 1024;
const MAX_MANAGED_RESTORE_RESPONSE_BYTES = 16 * 1024;
const MAX_MANAGED_LIFECYCLE_RESPONSE_BYTES = 256 * 1024;
const MANAGED_RIPGIT_PAGE_SIZE = 100;

const PORTABLE_ARCHIVE_BLOCKERS = [
  "tenant-level archive orchestration belongs to the deployment controller",
  "use the authenticated object snapshot and restore streams with a portable archive owner",
] as const;

export function isManagedRoute(pathname: string): boolean {
  return pathname === MANAGED_ROUTE_PREFIX
    || pathname.startsWith(`${MANAGED_ROUTE_PREFIX}/`);
}

export async function handleManagedRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authorization = await authorizeManagedAdmin(request, env);
  if (!authorization.configured) {
    await cancelRequestBody(request, "Managed route is not published");
    return noStoreResponse("Not Found", 404);
  }
  if (!authorization.configurationValid || !authorization.authorized) {
    await cancelRequestBody(request, "Managed authorization failed");
    return noStoreResponse("Forbidden", 403);
  }

  const pathname = new URL(request.url).pathname;
  try {
    if (pathname === `${MANAGED_ROUTE_PREFIX}/health`) {
      if (request.method !== "GET") {
        return await methodNotAllowed(request, ["GET"]);
      }
      await cancelRequestBody(request, "Managed health request does not accept a body");
      return managedJson({ status: "healthy", release: SERVER_RELEASE });
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/setup-token-policy`) {
      if (request.method !== "POST") {
        return await methodNotAllowed(request, ["POST"]);
      }
      const policy = await readSetupTokenPolicyRequest(request);
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      const result = await kernel.installManagedSetupTokenPolicy(policy);
      if (!result.ok) {
        return managedJson({
          error: result.reason,
          currentVersion: result.currentVersion,
        }, 409);
      }
      return managedJson({
        status: result.disposition,
        policy: result.policy,
      });
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/status`) {
      if (request.method !== "GET") {
        return await methodNotAllowed(request, ["GET"]);
      }
      await cancelRequestBody(request, "Managed status request does not accept a body");
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      const status = await kernel.managedStatus();
      return managedJson({
        status: "ready",
        release: SERVER_RELEASE,
        runtime: status,
        lifecycle: {
          export: { supported: false, blockers: PORTABLE_ARCHIVE_BLOCKERS },
          restore: { supported: false, blockers: PORTABLE_ARCHIVE_BLOCKERS },
          erase: { supported: true },
        },
      });
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/objects/describe`) {
      if (request.method !== "POST") {
        return await methodNotAllowed(request, ["POST"]);
      }
      const input = await readManagedObjectDescriptorRequest(request);
      try {
        const batch = input.component === "gateway"
          ? await describeGatewayManagedObjects(env, input.kind, input.providerIds)
          : input.component === "ripgit"
            ? await describeRipgitManagedObjects(request, env, input.kind, input.providerIds)
            : await managedAdapterServices(env)[input.component].managedDescribeObjects({
              kind: input.kind,
              providerIds: input.providerIds,
            });
        return managedJson(validateManagedDescriptorBatch(
          batch,
          input.kind,
          input.providerIds,
        ));
      } catch (error) {
        if (error instanceof ManagedProviderIdError) {
          throw new ManagedRequestInputError(400, "invalid_provider_id");
        }
        throw error;
      }
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/objects/snapshot`) {
      if (request.method !== "POST") {
        return await methodNotAllowed(request, ["POST"]);
      }
      assertManagedRequestHasNoQuery(request);
      const input = await readManagedSnapshotRequest(request);
      const stream = await snapshotManagedObject(request, env, input);
      return new Response(stream, {
        headers: {
          "cache-control": "no-store",
          "content-type": DATA_FRAME_STREAM_MEDIA_TYPE,
        },
      });
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/objects/restore`) {
      if (request.method !== "POST") {
        return await methodNotAllowed(request, ["POST"]);
      }
      assertManagedRequestHasNoQuery(request);
      const decoded = await readManagedRestoreRequest(request);
      let forwarded: ReadableStream<Uint8Array> | null = null;
      try {
        if (decoded.control.component === "ripgit") {
          forwarded = encodeDataFrameStream(prependRestoreControl(
            decoded.control,
            decoded.records,
          ));
          const result = await restoreRipgitManagedObject(
            request,
            env,
            decoded.control,
            forwarded,
          );
          forwarded = null;
          return managedJson(validateManagedRestoreResult(result, decoded.control));
        }
        forwarded = encodeDataFrameStream(decoded.records);
        const result = await restoreRpcManagedObject(env, decoded.control, forwarded);
        forwarded = null;
        return managedJson(validateManagedRestoreResult(result, decoded.control));
      } catch (error) {
        if (forwarded && !forwarded.locked) {
          await forwarded.cancel(error).catch(() => {});
        } else {
          await decoded.records.return(undefined).catch(() => {});
        }
        throw error;
      }
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/export`) {
      if (request.method !== "GET") {
        return await methodNotAllowed(request, ["GET"]);
      }
      await cancelRequestBody(request, "Portable export request does not accept a body");
      return managedJson({
        error: "portable_export_unavailable",
        blockers: PORTABLE_ARCHIVE_BLOCKERS,
      }, 501);
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/restore`) {
      if (request.method !== "POST") {
        return await methodNotAllowed(request, ["POST"]);
      }
      await cancelRequestBody(request, "Portable restore is unavailable");
      return managedJson({
        error: "portable_restore_unavailable",
        blockers: PORTABLE_ARCHIVE_BLOCKERS,
      }, 501);
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/update/fence`) {
      if (request.method !== "POST") {
        return await methodNotAllowed(request, ["POST"]);
      }
      await cancelRequestBody(request, "Update fence request does not accept a body");
      const inventory = await fenceTenantRuntime(request, env, ctx);
      return managedJson({ status: "fenced", ...inventory });
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/update/resume`) {
      if (request.method !== "POST") {
        return await methodNotAllowed(request, ["POST"]);
      }
      await cancelRequestBody(request, "Update resume request does not accept a body");
      const inventory = await resumeTenantRuntime(request, env, ctx);
      return managedJson({ status: "active", ...inventory });
    }

    if (pathname === `${MANAGED_ROUTE_PREFIX}/erase`) {
      if (request.method !== "DELETE") {
        return await methodNotAllowed(request, ["DELETE"]);
      }
      await cancelRequestBody(request, "Erase request does not accept a body");
      const erased = await eraseTenantRuntime(request, env, ctx);
      return managedJson({ status: "erased", ...erased });
    }

    await cancelRequestBody(request, "Managed route not found");
    return noStoreResponse("Not Found", 404);
  } catch (error) {
    await cancelRequestBody(request, "Managed request failed");
    if (error instanceof ManagedRequestInputError) {
      return managedJson({ error: error.code }, error.status);
    }
    return noStoreResponse("Managed request failed", 500);
  }
}

class ManagedRequestInputError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: string,
  ) {
    super(code);
    this.name = "ManagedRequestInputError";
  }
}

async function readSetupTokenPolicyRequest(request: Request): Promise<SetupTokenPolicy> {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ManagedRequestInputError(415, "json_content_type_required");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^[0-9]+$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_SETUP_TOKEN_POLICY_BODY_BYTES) {
      throw new ManagedRequestInputError(413, "request_too_large");
    }
  }

  const bytes = await readBoundedRequestBody(request, MAX_SETUP_TOKEN_POLICY_BODY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ManagedRequestInputError(400, "invalid_json");
  }
  try {
    return parseSetupTokenPolicy(value);
  } catch (error) {
    if (error instanceof SetupTokenPolicyValidationError) {
      throw new ManagedRequestInputError(400, "invalid_setup_token_policy");
    }
    throw error;
  }
}

type ManagedObjectDescriptorRequest =
  | {
      component: "gateway";
      kind: GatewayManagedObjectKind;
      providerIds: string[];
    }
  | {
      component: ManagedAdapterName;
      kind: "adapter_account" | "adapter_admission";
      providerIds: string[];
    }
  | {
      component: "ripgit";
      kind: "repository" | "repository_registry";
      providerIds: string[];
    };

async function readManagedObjectDescriptorRequest(
  request: Request,
): Promise<ManagedObjectDescriptorRequest> {
  const value = await readManagedJsonRequest(
    request,
    MAX_MANAGED_OBJECT_DESCRIPTOR_BODY_BYTES,
  );
  if (!value || typeof value !== "object") {
    throw new ManagedRequestInputError(400, "invalid_descriptor_request");
  }
  const candidate = value as {
    component?: unknown;
    kind?: unknown;
    providerIds?: unknown;
  };
  const component = candidate.component;
  if (
    component !== "gateway"
    && component !== "ripgit"
    && component !== "whatsapp"
    && component !== "discord"
    && component !== "telegram"
  ) {
    throw new ManagedRequestInputError(400, "invalid_descriptor_component");
  }
  const gatewayKind = isGatewayManagedObjectKind(candidate.kind);
  const adapterKind = candidate.kind === "adapter_account"
    || candidate.kind === "adapter_admission";
  const ripgitKind = candidate.kind === "repository"
    || candidate.kind === "repository_registry";
  if (
    (component === "gateway" && !gatewayKind)
    || (component === "ripgit" && !ripgitKind)
    || (component !== "gateway" && component !== "ripgit" && !adapterKind)
  ) {
    throw new ManagedRequestInputError(400, "invalid_descriptor_kind");
  }
  let providerIds: string[];
  try {
    providerIds = normalizeManagedProviderIds(candidate.providerIds);
  } catch {
    throw new ManagedRequestInputError(400, "invalid_provider_ids");
  }
  if (component === "gateway") {
    return {
      component,
      kind: candidate.kind as GatewayManagedObjectKind,
      providerIds,
    };
  }
  if (component === "ripgit") {
    return {
      component,
      kind: candidate.kind as "repository" | "repository_registry",
      providerIds,
    };
  }
  return {
    component,
    kind: candidate.kind as "adapter_account" | "adapter_admission",
    providerIds,
  };
}

async function readManagedSnapshotRequest(
  request: Request,
): Promise<ManagedObjectSnapshotRequest> {
  const value = await readManagedJsonRequest(request, MAX_MANAGED_SNAPSHOT_REQUEST_BYTES);
  try {
    return validateManagedSnapshotRequest(value);
  } catch {
    throw new ManagedRequestInputError(400, "invalid_snapshot_request");
  }
}

async function readManagedRestoreRequest(request: Request): Promise<{
  control: ManagedObjectRestoreControl;
  records: AsyncGenerator<DataFrameStreamRecord>;
}> {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== DATA_FRAME_STREAM_MEDIA_TYPE) {
    throw new ManagedRequestInputError(415, "data_frame_stream_content_type_required");
  }
  if (!request.body) {
    throw new ManagedRequestInputError(400, "restore_stream_required");
  }
  const records = decodeDataFrameStream(request.body, {
    maxFirstBodyBytes: DATA_FRAME_STREAM_MAX_RESTORE_CONTROL_BYTES,
  });
  try {
    const first = await records.next();
    if (first.done) {
      throw new ManagedRequestInputError(400, "restore_control_required");
    }
    if (
      first.value.kind !== DATA_FRAME_STREAM_CONTROL_KIND
      || first.value.body.byteLength > DATA_FRAME_STREAM_MAX_RESTORE_CONTROL_BYTES
    ) {
      throw new ManagedRequestInputError(400, "invalid_restore_control");
    }
    let control: ManagedObjectRestoreControl;
    try {
      control = decodeManagedRestoreControl(first.value);
    } catch {
      throw new ManagedRequestInputError(400, "invalid_restore_control");
    }
    return { control, records };
  } catch (error) {
    await records.return(undefined).catch(() => {});
    throw error;
  }
}

async function snapshotManagedObject(
  sourceRequest: Request,
  env: Env,
  input: ManagedObjectSnapshotRequest,
): Promise<ReadableStream<Uint8Array>> {
  let stream: unknown;
  if (input.component === "gateway") {
    assertGatewayPortableProviderIdentity(env, input.kind, input.logicalName, input.providerId);
    switch (input.kind) {
      case "kernel":
        stream = await (await getAgentByName(env.KERNEL, input.logicalName)).managedSnapshot(input);
        break;
      case "process":
        stream = await (await getAgentByName(env.PROCESS, input.logicalName)).managedSnapshot(input);
        break;
      case "app_runner":
        stream = await env.APP_RUNNER.getByName(input.logicalName).managedSnapshot(input);
        break;
      default:
        throw new ManagedRequestInputError(400, "invalid_snapshot_kind");
    }
  } else if (input.component === "ripgit") {
    stream = await snapshotRipgitManagedObject(sourceRequest, env, input);
  } else {
    stream = await managedAdapterServices(env)[input.component].managedSnapshot(input);
  }
  if (!isReadableByteStream(stream) || stream.locked) {
    throw new Error("Managed object returned an invalid snapshot stream");
  }
  return stream;
}

async function restoreRpcManagedObject(
  env: Env,
  control: ManagedObjectRestoreControl,
  stream: ReadableStream<Uint8Array>,
): Promise<unknown> {
  if (control.component === "gateway") {
    const providerId = gatewayProviderId(env, control.kind, control.logicalName);
    let result: unknown;
    switch (control.kind) {
      case "kernel":
        result = await (await getAgentByName(env.KERNEL, control.logicalName))
          .managedRestore(control, stream);
        break;
      case "process":
        result = await (await getAgentByName(env.PROCESS, control.logicalName))
          .managedRestore(control, stream);
        break;
      case "app_runner":
        result = await env.APP_RUNNER.getByName(control.logicalName)
          .managedRestore(control, stream);
        break;
      default:
        throw new ManagedRequestInputError(400, "invalid_restore_kind");
    }
    if ((result as { providerId?: unknown })?.providerId !== providerId) {
      throw new Error("Managed gateway restore returned the wrong provider identity");
    }
    return result;
  }
  if (control.component === "ripgit") {
    throw new ManagedRequestInputError(400, "invalid_restore_component");
  }
  const service = managedAdapterServices(env)[control.component];
  const result = await service.managedRestore(control, stream);
  const providerId = (result as { providerId?: unknown })?.providerId;
  if (typeof providerId !== "string") {
    throw new Error("Managed adapter restore did not return a provider identity");
  }
  const batch = validateManagedDescriptorBatch(
    await service.managedDescribeObjects({
      kind: "adapter_account",
      providerIds: [providerId],
    }),
    "adapter_account",
    [providerId],
  );
  const descriptor = batch.objects[0]!;
  if (
    descriptor.logicalName !== control.logicalName
    || descriptor.lifecycle.status !== "paused"
    || descriptor.lifecycle.epoch !== control.fenceEpoch
  ) {
    throw new Error("Managed adapter restore identity or fence does not match its control");
  }
  return result;
}

function gatewayProviderId(
  env: Env,
  kind: ManagedObjectRestoreControl["kind"],
  logicalName: string,
): string {
  switch (kind) {
    case "kernel":
      return env.KERNEL.idFromName(logicalName).toString();
    case "process":
      return env.PROCESS.idFromName(logicalName).toString();
    case "app_runner":
      return env.APP_RUNNER.idFromName(logicalName).toString();
    default:
      throw new ManagedRequestInputError(400, "invalid_gateway_object_kind");
  }
}

function assertGatewayPortableProviderIdentity(
  env: Env,
  kind: ManagedObjectSnapshotRequest["kind"],
  logicalName: string,
  providerId: string,
): void {
  if (gatewayProviderId(env, kind, logicalName) !== providerId) {
    throw new ManagedRequestInputError(400, "provider_identity_mismatch");
  }
  try {
    const namespace = kind === "kernel"
      ? env.KERNEL
      : kind === "process"
        ? env.PROCESS
        : kind === "app_runner"
          ? env.APP_RUNNER
          : null;
    if (!namespace || namespace.idFromString(providerId).toString() !== providerId) {
      throw new Error("invalid");
    }
  } catch {
    throw new ManagedRequestInputError(400, "invalid_provider_id");
  }
}

async function snapshotRipgitManagedObject(
  sourceRequest: Request,
  env: Env,
  input: ManagedObjectSnapshotRequest,
): Promise<ReadableStream<Uint8Array>> {
  const authorization = sourceRequest.headers.get("authorization");
  if (!authorization) throw new Error("Managed authorization was unavailable for ripgit");
  const response = await env.RIPGIT.fetch(new Request(
    "https://ripgit.internal/__gsv/managed/v1/ripgit/objects/snapshot",
    {
      method: "POST",
      headers: {
        authorization,
        "cache-control": "no-store",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: sourceRequest.signal,
    },
  ));
  if (
    !response.ok
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      !== DATA_FRAME_STREAM_MEDIA_TYPE
    || !response.body
  ) {
    await response.body?.cancel("Ripgit managed snapshot failed").catch(() => {});
    throw new Error("Ripgit managed snapshot failed");
  }
  return response.body;
}

async function restoreRipgitManagedObject(
  sourceRequest: Request,
  env: Env,
  control: ManagedObjectRestoreControl,
  stream: ReadableStream<Uint8Array>,
): Promise<unknown> {
  const authorization = sourceRequest.headers.get("authorization");
  if (!authorization) throw new Error("Managed authorization was unavailable for ripgit");
  const response = await env.RIPGIT.fetch(new Request(
    "https://ripgit.internal/__gsv/managed/v1/ripgit/objects/restore",
    {
      method: "POST",
      headers: {
        authorization,
        "cache-control": "no-store",
        "content-type": DATA_FRAME_STREAM_MEDIA_TYPE,
      },
      body: stream,
      signal: sourceRequest.signal,
    },
  ));
  if (!response.ok) {
    await response.body?.cancel("Ripgit managed restore failed").catch(() => {});
    throw new Error("Ripgit managed restore failed");
  }
  const result = await readBoundedManagedResponseJson(
    response,
    MAX_MANAGED_RESTORE_RESPONSE_BYTES,
  );
  const providerId = (result as { providerId?: unknown })?.providerId;
  if (typeof providerId !== "string") {
    throw new Error("Ripgit managed restore did not return a provider identity");
  }
  const batch = validateManagedDescriptorBatch(
    await describeRipgitManagedObjects(sourceRequest, env, "repository", [providerId]),
    "repository",
    [providerId],
  );
  const descriptor = batch.objects[0]!;
  if (
    descriptor.logicalName !== control.logicalName
    || descriptor.lifecycle.status !== "paused"
    || descriptor.lifecycle.epoch !== control.fenceEpoch
  ) {
    throw new Error("Ripgit restore identity or fence does not match its control");
  }
  return result;
}

async function* prependRestoreControl(
  control: ManagedObjectRestoreControl,
  records: AsyncIterable<DataFrameStreamRecord>,
): AsyncGenerator<DataFrameStreamRecord> {
  yield encodeManagedRestoreControl(control);
  yield* records;
}

function validateManagedRestoreResult(
  value: unknown,
  control: ManagedObjectRestoreControl,
): {
  status: "applied" | "replayed";
  providerId: string;
  frameCount: string;
  bodyBytes: string;
  semanticSha256: string;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Managed object returned an invalid restore result");
  }
  const result = value as Record<string, unknown>;
  if (
    (result.status !== "applied" && result.status !== "replayed")
    || typeof result.providerId !== "string"
    || result.providerId.length === 0
    || result.frameCount !== control.frameCount
    || result.bodyBytes !== control.bodyBytes
    || result.semanticSha256 !== control.semanticSha256
  ) {
    throw new Error("Managed object returned an invalid restore result");
  }
  return result as ReturnType<typeof validateManagedRestoreResult>;
}

function assertManagedRequestHasNoQuery(request: Request): void {
  if (new URL(request.url).search !== "") {
    throw new ManagedRequestInputError(400, "managed_metadata_must_not_be_in_url");
  }
}

function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value
    && typeof value === "object"
    && typeof (value as ReadableStream<Uint8Array>).getReader === "function"
    && typeof (value as ReadableStream<Uint8Array>).cancel === "function";
}

async function describeRipgitManagedObjects(
  sourceRequest: Request,
  env: Env,
  kind: "repository" | "repository_registry",
  providerIds: string[],
): Promise<unknown> {
  const authorization = sourceRequest.headers.get("authorization");
  if (!authorization) {
    throw new Error("Managed authorization was not available for ripgit forwarding");
  }
  const response = await env.RIPGIT.fetch(new Request(
    "https://ripgit.internal/__gsv/managed/v1/ripgit/objects/describe",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ kind, providerIds }),
      signal: sourceRequest.signal,
    },
  ));
  if (!response.ok) {
    await response.body?.cancel("Ripgit managed descriptor request failed").catch(() => {});
    throw new Error("Ripgit managed descriptor request failed");
  }
  return readBoundedManagedResponseJson(response, MAX_MANAGED_DESCRIPTOR_RESPONSE_BYTES);
}

async function readBoundedManagedResponseJson(
  response: Response,
  maximum: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > maximum) {
    await response.body?.cancel("Managed descriptor response was too large").catch(() => {});
    throw new Error("Managed descriptor response was too large");
  }
  if (!response.body) throw new Error("Managed descriptor response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel("Managed descriptor response was too large").catch(() => {});
        throw new Error("Managed descriptor response was too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes));
  } catch {
    throw new Error("Managed descriptor response was not valid JSON");
  }
}

function validateManagedDescriptorBatch(
  value: unknown,
  expectedKind: ManagedObjectKind,
  providerIds: string[],
): ManagedObjectDescriptorBatch {
  if (!value || typeof value !== "object") {
    throw new Error("Managed component returned an invalid descriptor batch");
  }
  const batch = value as Partial<ManagedObjectDescriptorBatch>;
  if (
    batch.schemaVersion !== MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION
    || batch.kind !== expectedKind
    || !Array.isArray(batch.objects)
    || batch.objects.length !== providerIds.length
  ) {
    throw new Error("Managed component returned an invalid descriptor batch");
  }
  const objects = batch.objects.map((descriptor, index) =>
    validateManagedObjectDescriptor(descriptor, expectedKind, providerIds[index]),
  );
  return {
    schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
    kind: expectedKind,
    objects,
  };
}

async function readManagedJsonRequest(
  request: Request,
  maximum: number,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ManagedRequestInputError(415, "json_content_type_required");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^[0-9]+$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maximum) {
      throw new ManagedRequestInputError(413, "request_too_large");
    }
  }
  const bytes = await readBoundedRequestBody(request, maximum);
  try {
    return JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes));
  } catch {
    throw new ManagedRequestInputError(400, "invalid_json");
  }
}

async function readBoundedRequestBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) throw new ManagedRequestInputError(400, "invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel("Managed setup-token policy request was too large").catch(() => {});
        throw new ManagedRequestInputError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

type RuntimeInventory = {
  processes: number;
  appRunners: number;
  adapters: ManagedAdapterAccountCounts;
  ripgit: { status: "paused" | "active" };
};

type ManagedAdapterName = "whatsapp" | "discord" | "telegram";
type ManagedAdapterAccountInventory = Record<ManagedAdapterName, string[]>;
type ManagedAdapterAccountCounts = Record<ManagedAdapterName, number>;
type ManagedAdapterService = {
  managedPause(accountIds: string[]): Promise<{ accountIds: string[] }>;
  managedResume(accountIds: string[]): Promise<{ accountIds: string[] }>;
  managedErase(accountIds: string[]): Promise<{ accountIds: string[] }>;
  managedFenceAll(): Promise<{
    status: "fenced" | "erased";
    epoch: number;
    drained: boolean;
  }>;
  managedResumeAll(): Promise<{ status: "active"; epoch: number }>;
  managedEraseAll(): Promise<
    | { status: "erased"; epoch: number; drained: true }
    | { status: "fenced"; epoch: number; drained: false }
  >;
  managedDescribeObjects(input: {
    kind: "adapter_account" | "adapter_admission";
    providerIds: string[];
  }): Promise<ManagedObjectDescriptorBatch>;
  managedSnapshot(input: ManagedObjectSnapshotRequest): Promise<ReadableStream<Uint8Array>>;
  managedRestore(
    control: ManagedObjectRestoreControl,
    stream: ReadableStream<Uint8Array>,
  ): Promise<unknown>;
};

async function fenceTenantRuntime(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<RuntimeInventory> {
  await changeAdapterAdmission(env, "managedFenceAll", "fenced");
  const ripgit = await changeRipgitLifecycle(request, env, "pause");
  const kernel = await getAgentByName(env.KERNEL, "singleton");
  const inventory = await kernel.managedPrepareUpdate();
  const adapters = await changeAdapterLifecycle(env, inventory.adapters, "managedPause");
  await forEachConcurrent(inventory.processIds, 8, async (processId) => {
    const process = await getAgentByName(env.PROCESS, processId);
    await process.managedPause();
  });
  await forEachConcurrent(inventory.appRunnerNames, 8, async (runnerName) => {
    const runner = env.APP_RUNNER.getByName(runnerName);
    await runner.managedPause();
  });
  return {
    processes: inventory.processIds.length,
    appRunners: inventory.appRunnerNames.length,
    adapters,
    ripgit,
  };
}

async function resumeTenantRuntime(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<RuntimeInventory> {
  await changeAdapterAdmission(env, "managedFenceAll", "fenced");
  await changeRipgitLifecycle(request, env, "pause");
  const kernel = await getAgentByName(env.KERNEL, "singleton");
  const inventory = await kernel.managedPrepareUpdate();

  // Normalize a retry after any partially completed resume back to a fully
  // fenced state before admitting work again.
  await forEachConcurrent(inventory.processIds, 8, async (processId) => {
    const process = await getAgentByName(env.PROCESS, processId);
    await process.managedPause();
  });
  await forEachConcurrent(inventory.appRunnerNames, 8, async (runnerName) => {
    const runner = env.APP_RUNNER.getByName(runnerName);
    await runner.managedPause();
  });
  await changeAdapterLifecycle(env, inventory.adapters, "managedPause");

  await forEachConcurrent(inventory.processIds, 8, async (processId) => {
    const process = await getAgentByName(env.PROCESS, processId);
    await process.managedResume();
  });
  await forEachConcurrent(inventory.appRunnerNames, 8, async (runnerName) => {
    const runner = env.APP_RUNNER.getByName(runnerName);
    await runner.managedResume();
  });
  await kernel.managedResumeUpdate();
  await forEachConcurrent(inventory.processIds, 8, async (processId) => {
    const process = await getAgentByName(env.PROCESS, processId);
    await process.managedActivate();
  });
  await forEachConcurrent(inventory.appRunnerNames, 8, async (runnerName) => {
    const runner = env.APP_RUNNER.getByName(runnerName);
    await runner.managedActivate();
  });
  const ripgit = await changeRipgitLifecycle(request, env, "resume");
  await kernel.managedActivate();
  const adapters = await changeAdapterLifecycle(env, inventory.adapters, "managedResume");
  await changeAdapterAdmission(env, "managedResumeAll", "active");

  return {
    processes: inventory.processIds.length,
    appRunners: inventory.appRunnerNames.length,
    adapters,
    ripgit,
  };
}

async function eraseTenantRuntime(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<{
  processes: number;
  appRunners: number;
  adapters: ManagedAdapterAccountCounts;
  ripgit: { status: "erased"; repositories: 0 };
  objects: number;
}> {
  await changeAdapterAdmission(env, "managedFenceAll", "fenced", true);
  const kernel = await getAgentByName(env.KERNEL, "singleton");
  const inventory = await kernel.managedPrepareErase();
  const ripgit = await eraseRipgit(request, env);

  await forEachConcurrent(inventory.processIds, 8, async (processId) => {
    const process = await getAgentByName(env.PROCESS, processId);
    await process.managedErase();
  });
  await forEachConcurrent(inventory.appRunnerNames, 8, async (runnerName) => {
    const runner = env.APP_RUNNER.getByName(runnerName);
    await runner.managedErase();
  });

  const adapters = await changeAdapterLifecycle(env, inventory.adapters, "managedErase");
  await changeAdapterAdmission(env, "managedEraseAll", "erased");

  const objects = await eraseR2(env.STORAGE);
  await kernel.managedErase();
  return {
    processes: inventory.processIds.length,
    appRunners: inventory.appRunnerNames.length,
    adapters,
    ripgit,
    objects,
  };
}

type RipgitGateStatus = "active" | "paused" | "resuming";
type RipgitErasureStatus = "ready" | "erasing" | "erased";
type RipgitLifecycleBatch = {
  gate: { status: RipgitGateStatus; epoch: number };
  erasure: { status: RipgitErasureStatus; epoch: number };
  pendingRepositories: number;
  repositories: unknown[];
  nextCursor: string | null;
};
type RipgitEraseBatch = {
  gate: { status: RipgitGateStatus; epoch: number };
  erasure: { status: RipgitErasureStatus; epoch: number };
  erasedRepositories: unknown[];
  nextCursor: string | null;
  remainingRepositories: number;
};

async function changeRipgitLifecycle(
  sourceRequest: Request,
  env: Env,
  operation: "pause" | "resume",
): Promise<{ status: "paused" | "active" }> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (;;) {
    const batch = validateRipgitLifecycleBatch(await callRipgitManagedJson(
      sourceRequest,
      env,
      operation,
      { cursor, limit: MANAGED_RIPGIT_PAGE_SIZE },
    ));
    if (batch.erasure.status !== "ready") {
      throw new Error(`Managed ripgit ${operation} encountered an irreversible erase`);
    }
    if (operation === "pause") {
      if (batch.gate.status !== "paused") {
        throw new Error("Managed ripgit did not acknowledge its pause fence");
      }
      if (batch.nextCursor === null) {
        if (batch.pendingRepositories !== 0) {
          throw new Error("Managed ripgit pause inventory was not fully acknowledged");
        }
        return { status: "paused" };
      }
    } else {
      if (batch.gate.status === "active") {
        if (batch.nextCursor !== null || batch.pendingRepositories !== 0) {
          throw new Error("Managed ripgit resumed with a non-terminal inventory");
        }
        return { status: "active" };
      }
      if (batch.gate.status !== "resuming" || batch.nextCursor === null) {
        throw new Error("Managed ripgit resume did not make bounded progress");
      }
    }
    cursor = advanceRipgitCursor(cursor, batch.nextCursor, seenCursors);
  }
}

async function eraseRipgit(
  sourceRequest: Request,
  env: Env,
): Promise<{ status: "erased"; repositories: 0 }> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (;;) {
    const batch = validateRipgitEraseBatch(await callRipgitManagedJson(
      sourceRequest,
      env,
      "erase",
      { cursor, limit: MANAGED_RIPGIT_PAGE_SIZE },
    ));
    if (batch.gate.status !== "paused" || batch.gate.epoch !== batch.erasure.epoch) {
      throw new Error("Managed ripgit erase was not fenced at its erase epoch");
    }
    if (batch.erasure.status === "erased") {
      if (batch.nextCursor !== null || batch.remainingRepositories !== 0) {
        throw new Error("Managed ripgit returned an inexact terminal erase inventory");
      }
      return { status: "erased", repositories: 0 };
    }
    if (batch.erasure.status !== "erasing" || batch.nextCursor === null) {
      throw new Error("Managed ripgit erase did not make bounded progress");
    }
    cursor = advanceRipgitCursor(cursor, batch.nextCursor, seenCursors);
  }
}

async function callRipgitManagedJson(
  sourceRequest: Request,
  env: Env,
  operation: "pause" | "resume" | "erase",
  body: { cursor: string | null; limit: number },
): Promise<unknown> {
  const authorization = sourceRequest.headers.get("authorization");
  if (!authorization) {
    throw new Error("Managed authorization was unavailable for ripgit lifecycle");
  }
  const response = await env.RIPGIT.fetch(new Request(
    `https://ripgit.internal/__gsv/managed/v1/ripgit/${operation}`,
    {
      method: "POST",
      headers: {
        authorization,
        "cache-control": "no-store",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: sourceRequest.signal,
    },
  ));
  if (!response.ok) {
    await response.body?.cancel(`Ripgit managed ${operation} failed`).catch(() => {});
    throw new Error(`Ripgit managed ${operation} failed`);
  }
  return readBoundedManagedResponseJson(response, MAX_MANAGED_LIFECYCLE_RESPONSE_BYTES);
}

function validateRipgitLifecycleBatch(value: unknown): RipgitLifecycleBatch {
  if (!value || typeof value !== "object") {
    throw new Error("Managed ripgit returned an invalid lifecycle response");
  }
  const batch = value as Record<string, unknown>;
  const gate = validateRipgitGate(batch.gate);
  const erasure = validateRipgitErasure(batch.erasure);
  if (
    !isNonNegativeSafeInteger(batch.pendingRepositories)
    || !Array.isArray(batch.repositories)
    || !isRipgitCursor(batch.nextCursor)
  ) {
    throw new Error("Managed ripgit returned an invalid lifecycle response");
  }
  return {
    gate,
    erasure,
    pendingRepositories: batch.pendingRepositories,
    repositories: batch.repositories,
    nextCursor: batch.nextCursor,
  };
}

function validateRipgitEraseBatch(value: unknown): RipgitEraseBatch {
  if (!value || typeof value !== "object") {
    throw new Error("Managed ripgit returned an invalid erase response");
  }
  const batch = value as Record<string, unknown>;
  const gate = validateRipgitGate(batch.gate);
  const erasure = validateRipgitErasure(batch.erasure);
  if (
    !Array.isArray(batch.erasedRepositories)
    || !isRipgitCursor(batch.nextCursor)
    || !isNonNegativeSafeInteger(batch.remainingRepositories)
  ) {
    throw new Error("Managed ripgit returned an invalid erase response");
  }
  return {
    gate,
    erasure,
    erasedRepositories: batch.erasedRepositories,
    nextCursor: batch.nextCursor,
    remainingRepositories: batch.remainingRepositories,
  };
}

function validateRipgitGate(value: unknown): RipgitLifecycleBatch["gate"] {
  const candidate = value as { status?: unknown; epoch?: unknown } | null;
  if (
    !candidate
    || (candidate.status !== "active"
      && candidate.status !== "paused"
      && candidate.status !== "resuming")
    || !isNonNegativeSafeInteger(candidate.epoch)
  ) {
    throw new Error("Managed ripgit returned an invalid gate state");
  }
  return { status: candidate.status, epoch: candidate.epoch };
}

function validateRipgitErasure(value: unknown): RipgitLifecycleBatch["erasure"] {
  const candidate = value as { status?: unknown; epoch?: unknown } | null;
  if (
    !candidate
    || (candidate.status !== "ready"
      && candidate.status !== "erasing"
      && candidate.status !== "erased")
    || !isNonNegativeSafeInteger(candidate.epoch)
  ) {
    throw new Error("Managed ripgit returned an invalid erasure state");
  }
  return { status: candidate.status, epoch: candidate.epoch };
}

function advanceRipgitCursor(
  current: string | null,
  next: string,
  seen: Set<string>,
): string {
  if ((current !== null && next <= current) || seen.has(next)) {
    throw new Error("Managed ripgit lifecycle cursor did not advance");
  }
  seen.add(next);
  return next;
}

function isRipgitCursor(value: unknown): value is string | null {
  return value === null
    || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function changeAdapterAdmission(
  env: Env,
  operation: keyof Pick<
    ManagedAdapterService,
    "managedFenceAll" | "managedResumeAll" | "managedEraseAll"
  >,
  expectedStatus: "fenced" | "active" | "erased",
  allowAlreadyErased = false,
): Promise<void> {
  const services = managedAdapterServices(env);
  await Promise.all(Object.entries(services).map(async ([adapter, service]) => {
    const result = await service[operation]();
    if (
      !result
      || (result.status !== expectedStatus
        && !(allowAlreadyErased && result.status === "erased"))
      || ((operation === "managedFenceAll" || operation === "managedEraseAll")
        && (!("drained" in result) || result.drained !== true))
      || !Number.isSafeInteger(result.epoch)
      || result.epoch < 0
    ) {
      throw new Error(`Managed ${adapter} admission gate did not acknowledge ${expectedStatus}`);
    }
  }));
}

async function changeAdapterLifecycle(
  env: Env,
  inventory: ManagedAdapterAccountInventory,
  operation: keyof Pick<ManagedAdapterService, "managedPause" | "managedResume" | "managedErase">,
): Promise<ManagedAdapterAccountCounts> {
  const services = managedAdapterServices(env);
  const entries = Object.entries(services) as Array<[ManagedAdapterName, ManagedAdapterService]>;
  const results = await Promise.all(entries.map(async ([adapter, service]) => {
    const expected = [...new Set(inventory[adapter])].sort();
    const batchCount = Math.max(
      1,
      Math.ceil(expected.length / MAX_ADAPTER_ACCOUNTS_PER_LIFECYCLE_CALL),
    );
    for (let index = 0; index < batchCount; index += 1) {
      const batch = expected.slice(
        index * MAX_ADAPTER_ACCOUNTS_PER_LIFECYCLE_CALL,
        (index + 1) * MAX_ADAPTER_ACCOUNTS_PER_LIFECYCLE_CALL,
      );
      const acknowledged = await service[operation](batch);
      if (
        !acknowledged
        || !Array.isArray(acknowledged.accountIds)
        || acknowledged.accountIds.length !== batch.length
        || acknowledged.accountIds.some((accountId, index) => accountId !== batch[index])
      ) {
        throw new Error(`Managed ${adapter} lifecycle inventory was not acknowledged`);
      }
    }
    return [adapter, expected.length] as const;
  }));
  return Object.fromEntries(results) as ManagedAdapterAccountCounts;
}

function managedAdapterServices(
  env: Env,
): Record<ManagedAdapterName, ManagedAdapterService> {
  return {
    whatsapp: env.CHANNEL_WHATSAPP as unknown as ManagedAdapterService,
    discord: env.CHANNEL_DISCORD as unknown as ManagedAdapterService,
    telegram: env.CHANNEL_TELEGRAM as unknown as ManagedAdapterService,
  };
}

async function eraseR2(bucket: R2Bucket): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await bucket.list({ limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length === 0) {
      return deleted;
    }
    await bucket.delete(keys);
    deleted += keys.length;
  }
}

async function forEachConcurrent<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += concurrency) {
    await Promise.all(values.slice(offset, offset + concurrency).map(operation));
  }
}

async function methodNotAllowed(request: Request, allow: string[]): Promise<Response> {
  await cancelRequestBody(request, "Managed method is not allowed");
  return noStoreResponse("Method Not Allowed", 405, { allow: allow.join(", ") });
}

async function cancelRequestBody(request: Request, reason: string): Promise<void> {
  if (request.body && !request.body.locked) {
    await request.body.cancel(reason).catch(() => {});
  }
}

function managedJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function noStoreResponse(
  body: string,
  status: number,
  headers?: HeadersInit,
): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}
