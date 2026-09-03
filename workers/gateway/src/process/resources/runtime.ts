/** Owns Process resource admission, storage, retention, and hydration. */

import type { Process } from "../do";
import {
  MAX_MESSAGE_MEDIA_ITEMS, MAX_MESSAGE_MEDIA_PART_BYTES, MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../../shared/message-media-limits";
import {
  resourceBlockSchema, type ProcMediaInput, type ResourceBlock, jsonValueSchema, type FileResourceReference,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  processMediaPath, processMediaPrefix, storeIncomingProcessMedia, type StoreIncomingProcessMediaOptions,
  buildImageBlock, describeStoredProcessMedia, parseStoredProcessMedia, type StoredProcessMedia,
} from "../media";
import {
  agentArchiveMediaPath, agentArchiveMediaPrefix, isValidAgentArchiveMediaObject,
} from "../../shared/process-media-path";
import { mediaTypeFromContentType } from "../history/helpers";
import { raceWithAbort } from "../../shared/abort";
import type { FrameBody, RequestFrame } from "../../protocol/frames";
import type { RunOutputMedia } from "../run/state";
import type { StagedResourceWriteArgs, StagedResourceWriteResult } from "../internal/contracts";
import { exactBodyLengthSchema } from "../internal/schemas";
import { stableOpaqueId } from "../../shared/stable-id";
import type {
  ProcessResourceWriteRequestFrame, ProcessResourcesRetainRequestFrame, ProcessRunAttachArgs, ProcessRunAttachResult,
} from "../../protocol/process-frames";
import type { MessageRecord } from "../store";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  MAX_PROCESS_MEDIA_READ_BYTES, retainedResourceBlock, type ArchivedMediaRewrite, type ResourceRetentionOptions,
  type ResourceRetentionResult,
} from "../internal/lifecycle";
import { encodeBase64Bytes } from "../../shared/base64";
import { isVectorImageMimeType } from "../../inference/image-mime";
import { cancelProcessRequests, sendFrameToKernel } from "../../shared/utils";
import { cancelResponseBody } from "../internal/messages";
import {
  extractFsReadResource, extractToolResultImages, replaceFsReadResource, wrapStoredToolResult,
} from "../tool-result-media";

function isCurrentMediaUpload(
  host: Process,
  pid: string,
  uid: number,
  lifecycleEpoch: number,
): boolean {
  return (
    host.isInitialized() &&
    host.pid === pid &&
    host.identity.uid === uid &&
    host.lifecycleEpoch === lifecycleEpoch
  );
}

function resourceWriteFailure(error: string): StagedResourceWriteResult {
  return { ok: false, error };
}

function outputMedia(
  args: Pick<StagedResourceWriteArgs, "type" | "filename" | "duration" | "transcription">,
  mimeType: string,
  key: string,
  path: string,
  size: number,
  revision?: string,
): RunOutputMedia {
  const media: RunOutputMedia = {
    type: args.type,
    mimeType,
    key,
    path,
    size,
  };
  if (revision) media.revision = revision;
  if (args.filename) media.filename = args.filename;
  if (args.duration !== undefined) media.duration = args.duration;
  if (args.transcription) media.transcription = args.transcription;
  return media;
}

type ResourceWritePlan = {
  body: FrameBody;
  length: number;
  mimeType: string;
  pid: string;
  identity: Process["identity"];
  lifecycleEpoch: number;
  requestedMediaId?: string;
  key: string;
  path: string;
  descriptorId: string;
};

type PreparedRunAttachments = {
  media: RunOutputMedia[];
  resources: ResourceBlock[];
};

export class ProcessResources {
  constructor(private readonly host: Process) {}

  private async rejectResourceWrite(
    body: FrameBody | undefined,
    reason: string,
    error = reason,
  ): Promise<StagedResourceWriteResult> {
    await body?.stream.cancel(reason).catch(() => {});
    return resourceWriteFailure(error);
  }

  private retentionIsCurrent(
    identity: Process["identity"],
    lifecycleEpoch: number,
    runId?: string,
  ): boolean {
    return (
      !this.host.killed &&
      this.host.isInitialized() &&
      this.host.lifecycleEpoch === lifecycleEpoch &&
      this.host.identity.uid === identity.uid &&
      this.host.identity.gid === identity.gid &&
      this.host.identity.home === identity.home &&
      (runId === undefined || this.host.runs.active?.runId === runId)
    );
  }

  private retainedObjectMatches(
    key: string,
    object: R2Object | null,
    source: Pick<FileResourceReference, "size" | "revision" | "contentType">,
    identity = this.host.identity,
  ): object is R2Object {
    return Boolean(
      object &&
      object.size === source.size &&
      this.isValidOwnedArchiveObject(
        key,
        object,
        { sourceEtag: source.revision, expectedContentType: source.contentType },
        identity,
      ),
    );
  }

  private assertRetentionPending(options: ResourceRetentionOptions): void {
    options.signal?.throwIfAborted();
    if (!options.current()) throw new Error("Resource is no longer pending");
  }

  private validateResourceRetention(
    source: FileResourceReference,
    options: ResourceRetentionOptions,
  ): void {
    this.assertRetentionPending(options);
    if (source.expiresAt !== undefined && source.expiresAt <= Date.now()) {
      throw new Error(`Resource has expired: ${source.path}`);
    }
    if (source.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
      throw new Error(`Resource exceeds the ${MAX_MESSAGE_MEDIA_PART_BYTES}-byte limit`);
    }
  }

  /** Consumes one exact-length body into R2 and removes any failed write. */
  private async storeExactObject(
    key: string,
    size: number,
    body: ReadableStream<Uint8Array>,
    options: R2PutOptions,
    signal?: AbortSignal,
  ): Promise<R2Object> {
    let fixed: FixedLengthStream;
    try {
      fixed = new FixedLengthStream(size);
    } catch (error) {
      await body.cancel(error).catch(() => {});
      throw error;
    }
    const [stored, piped] = await Promise.allSettled([
      this.host.storage.put(key, fixed.readable, options),
      body.pipeTo(fixed.writable, { signal }),
    ]);
    if (stored.status === "rejected") {
      await this.host.storage.delete(key);
      throw stored.reason instanceof Error ? stored.reason : new Error(String(stored.reason));
    }
    if (piped.status === "rejected") {
      await this.host.storage.delete(key);
      throw piped.reason instanceof Error ? piped.reason : new Error(String(piped.reason));
    }
    if (stored.value.size !== size) {
      await this.host.storage.delete(key);
      throw new Error(`Stored ${stored.value.size} bytes, expected ${size}`);
    }
    return stored.value;
  }

  private async requestResourceBody(
    source: FileResourceReference,
    options: ResourceRetentionOptions,
  ): Promise<FrameBody> {
    const requestId = crypto.randomUUID();
    const request: RequestFrame<"fs.transfer.send"> = {
      type: "req",
      id: requestId,
      call: "fs.transfer.send",
      args: { target: source.target, path: source.path, revision: source.revision },
      runId: options.runId,
    };
    const pending = sendFrameToKernel(this.host.installationId, this.host.pid, request);
    let cancellation: Promise<number> | undefined;
    let response: Awaited<typeof pending>;
    try {
      response = await raceWithAbort(pending, options.signal, {
        abortReason: () => options.signal?.reason ?? new Error("Request cancelled"),
        onAbort: () => {
          const reason =
            options.signal?.reason instanceof Error
              ? options.signal.reason.message
              : "Request cancelled";
          cancellation = cancelProcessRequests(
            this.host.installationId,
            this.host.pid,
            [requestId],
            reason,
          );
        },
        onLateResolve: (late) => {
          if (late?.type === "res") void cancelResponseBody(late, "Resource request was cancelled");
        },
      });
    } catch (error) {
      await cancellation?.catch(() => 0);
      throw error;
    }
    if (options.signal?.aborted) {
      if (response?.type === "res")
        await cancelResponseBody(response, "Resource request was cancelled");
      options.signal.throwIfAborted();
    }
    if (!response || response.type !== "res") {
      throw new Error(`Resource source did not respond: ${source.target}:${source.path}`);
    }
    if (!options.current()) {
      await cancelResponseBody(response, "Resource is no longer pending");
      throw new Error("Resource is no longer pending");
    }
    if (!response.ok) {
      await cancelResponseBody(response, "Resource source rejected the request");
      throw new Error(response.error.message);
    }
    if (!response.data?.ok) {
      await cancelResponseBody(response, "Resource source rejected the requested revision");
      throw new Error(response.data?.error ?? "Resource source returned no result");
    }
    if (!response.body) throw new Error("Resource source returned no body");
    const result = response.data;
    if (
      result.path !== source.path ||
      result.size !== source.size ||
      result.revision !== source.revision ||
      result.contentType !== source.contentType ||
      response.body.length !== source.size
    ) {
      await response.body.stream
        .cancel("Resource source changed during resolution")
        .catch(() => {});
      throw new Error(`Resource source changed during resolution: ${source.path}`);
    }
    return response.body;
  }

  async acquireMediaKeyAdmission(key: string): Promise<() => void> {
    const previous = this.host.mediaWriteAdmissions.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.host.mediaWriteAdmissions.set(key, current);
    await previous;
    return () => {
      if (this.host.mediaWriteAdmissions.get(key) === current) {
        this.host.mediaWriteAdmissions.delete(key);
      }
      release();
    };
  }

  async acquireMediaKeyAdmissions(keys: string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    try {
      for (const key of [...new Set(keys)].sort()) {
        releases.push(await this.acquireMediaKeyAdmission(key));
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  async firstMissingMediaKey(keys: string[]): Promise<string | null> {
    for (const key of keys) {
      if (!(await this.host.storage.head(key))) return key;
    }
    return null;
  }

  abortMediaUploads(reason: Error): void {
    for (const controller of this.host.mediaUploadAbortControllers.values()) {
      controller.abort(reason);
    }
    this.host.mediaUploadAbortControllers.clear();
  }

  async resolveIncomingMedia(
    input: Array<ResourceBlock | ProcMediaInput> | undefined,
  ): Promise<ProcMediaInput[]> {
    if (!input?.length) return [];
    if (input.length > MAX_MESSAGE_MEDIA_ITEMS) {
      throw new Error(`Message media exceeds item limit (${MAX_MESSAGE_MEDIA_ITEMS})`);
    }
    const identity = this.host.identity;
    const lifecycleEpoch = this.host.lifecycleEpoch;
    const media: ProcMediaInput[] = [];
    let totalBytes = 0;
    for (const candidate of input) {
      if (candidate.type !== "resource") {
        const key = candidate.key?.trim();
        if (key) {
          const active =
            key.startsWith(processMediaPrefix(identity.uid, this.host.pid)) &&
            processMediaPath(key) !== null;
          const object = await this.host.storage.head(key);
          const archived =
            agentArchiveMediaPath(identity.home, key) !== null &&
            object !== null &&
            this.isValidOwnedArchiveObject(key, object, {
              expectedContentType: candidate.mimeType,
            });
          if (!active && !archived) throw new Error("media key is outside this process");
        }
        media.push(candidate);
        continue;
      }

      let resource = resourceBlockSchema.parse(candidate);
      if (!(await this.isOwnedResource(resource))) {
        resource = (
          await this.retainResource(resource, {
            current: () => this.retentionIsCurrent(identity, lifecycleEpoch),
          })
        ).resource;
      }
      const { ref } = resource;
      totalBytes += ref.size;
      if (ref.size > MAX_MESSAGE_MEDIA_PART_BYTES || totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
        throw new Error("Message media exceeds the attachment byte limit");
      }
      media.push({
        type: resource.mediaType ?? mediaTypeFromContentType(ref.contentType),
        mimeType: ref.contentType,
        key: ref.path.replace(/^\/+/, ""),
        path: ref.path,
        size: ref.size,
        filename: resource.filename,
        duration: resource.duration,
        transcription: resource.transcription,
      });
    }
    return media;
  }

  async isOwnedResource(resource: ResourceBlock): Promise<boolean> {
    const { ref } = resource;
    if (ref.target !== "gsv" || ref.expiresAt !== undefined) return false;
    const key = ref.path.replace(/^\/+/, "");
    if (agentArchiveMediaPath(this.host.identity.home, key) !== ref.path) return false;
    const object = await this.host.storage.head(key);
    return Boolean(
      object &&
      object.httpEtag === ref.revision &&
      object.size === ref.size &&
      this.isValidOwnedArchiveObject(key, object, {
        expectedContentType: ref.contentType,
      }),
    );
  }

  async prepareRunMedia(runId: string, messageId: number, input: ProcMediaInput[]): Promise<void> {
    if (this.host.handleRunStopped(runId)) {
      return;
    }
    const pid = this.host.pid;
    const identity = this.host.identity;
    const uid = identity.uid;
    const mediaKeys = input.flatMap((item) => (item.key ? [item.key] : []));
    const releaseMedia = await this.acquireMediaKeyAdmissions(mediaKeys);
    try {
      if (this.host.handleRunStopped(runId)) {
        return;
      }
      const signal = this.host.run.runAbortSignal(runId);
      try {
        const options = await raceWithAbort(this.resolveMediaProcessingOptions(input), signal);
        const media = await raceWithAbort(
          storeIncomingProcessMedia(this.host.storage, uid, pid, input, {
            ...options,
            signal,
            allowedStoredKeys: new Set(
              input.flatMap((item) =>
                item.key && agentArchiveMediaPath(identity.home, item.key) ? [item.key] : [],
              ),
            ),
          }),
          signal,
        );
        const admitted = this.host.ctx.storage.transactionSync(() => {
          const run = this.host.runs.active;
          if (
            !this.host.killed &&
            this.host.lifecyclePhase === "ready" &&
            run?.runId === runId &&
            run.pendingMediaMessageId === messageId
          ) {
            if (media) {
              this.host.store.messages.updateMessageMedia(messageId, runId, media);
            }
            delete run.pendingMediaMessageId;
            this.host.runs.active = run;
            return true;
          }
          return false;
        });
        if (admitted && media) {
          this.host.startBackground(
            `media change notification for ${runId}`,
            this.host.signals.changed(["messages"], {
              runId,
              messageId,
            }),
          );
        }
        if (!admitted) {
          return;
        }
        try {
          await this.host.run.scheduleTick(runId);
        } catch (error) {
          if (this.host.handleRunStopped(runId)) {
            return;
          }
          const message = `Failed to schedule process run: ${error instanceof Error ? error.message : String(error)}`;
          await this.host.controller.appendRuntimeMessage(message, {
            runId,
          });
          await this.host.run.finishRun(runId, {
            reason: "schedule.error",
            status: "error",
            resultText: null,
            error: message,
          });
        }
      } catch (error) {
        if (signal.aborted || this.host.killed || this.host.lifecyclePhase !== "ready") {
          return;
        }
        const prefix = processMediaPrefix(uid, pid);
        const keys = input.flatMap((item) => (item.key?.startsWith(prefix) ? [item.key] : []));
        this.host.store.messages.clearMessageMedia(messageId, runId);
        const unreferenced = keys.filter(
          (key) => !this.host.store.messages.referencesMediaKey(key),
        );
        if (unreferenced.length > 0) {
          await this.host.storage.delete(unreferenced);
        }
        await this.failPendingMedia(
          runId,
          messageId,
          `Failed to prepare message media: ${error instanceof Error ? error.message : String(error)}`,
          "media.error",
        );
      }
    } finally {
      releaseMedia();
    }
  }

  async failPendingMedia(
    runId: string,
    messageId: number,
    message: string,
    reason: "media.error" | "media.timeout",
  ): Promise<void> {
    const completed = this.host.ctx.storage.transactionSync(() => {
      if (this.host.killed || this.host.lifecyclePhase !== "ready") return null;
      const run = this.host.runs.active;
      if (run?.runId !== runId || run.pendingMediaMessageId !== messageId) {
        return null;
      }
      this.host.store.messages.appendMessage("system", message, { runId });
      return this.host.run.commitRunFinishState(run, {
        reason,
        status: "error",
        resultText: null,
        error: message,
      });
    });
    if (!completed) return;
    this.host.runAbortControllers.get(runId)?.abort(new Error(message));
    this.host.runAbortControllers.delete(runId);
    this.host.startBackground(
      `media failure notification for ${runId}`,
      this.host.signals.changed(["messages"], { runId }),
    );
    await this.host.run.completeRunTransition(completed);
  }

  async resolveMediaProcessingOptions(
    media: ProcMediaInput[] | undefined,
  ): Promise<StoreIncomingProcessMediaOptions> {
    if (!media || media.length === 0) {
      return { ai: this.host.env.AI };
    }

    const config = await this.host.settings.resolveAiConfig();
    return {
      ai: this.host.env.AI,
      audioTranscriptionProvider: config.media?.transcriptionProvider,
      audioTranscriptionModel: config.media?.transcriptionModel,
      audioTranscriptionApiKey: config.media?.transcriptionApiKey,
      maxTranscriptionBytes: config.media?.transcriptionMaxBytes,
      imageReadingMaxBytes: config.media?.imageReadingMaxBytes,
      imageReadingMaxTokens: config.media?.imageReadingMaxTokens,
      imageReadingTimeoutMs: config.media?.imageReadingTimeoutMs,
    };
  }

  private async prepareResourceWrite(
    args: StagedResourceWriteArgs,
    body?: FrameBody,
  ): Promise<ResourceWritePlan | StagedResourceWriteResult> {
    if (this.host.killed || !this.host.isInitialized()) {
      return this.rejectResourceWrite(body, "Process no longer exists");
    }
    if (!body) return resourceWriteFailure("Resource write requires a body");
    const parsedLength = exactBodyLengthSchema.safeParse(body.length);
    if (!parsedLength.success) {
      return this.rejectResourceWrite(
        body,
        "Missing media body length",
        "Resource write requires an exact body length",
      );
    }
    const mimeType = args.mimeType.trim();
    if (!mimeType) {
      return this.rejectResourceWrite(
        body,
        "Missing media MIME type",
        "Resource write requires contentType",
      );
    }
    const requestedMediaId = args.mediaId?.trim();
    if (
      requestedMediaId !== undefined &&
      (requestedMediaId.length === 0 ||
        requestedMediaId.length > 160 ||
        requestedMediaId === ".dir" ||
        !/^[a-zA-Z0-9._:-]+$/.test(requestedMediaId))
    ) {
      return this.rejectResourceWrite(body, "Invalid media id", "Resource id is invalid");
    }
    const pid = this.host.pid;
    const identity = this.host.identity;
    const key = `${processMediaPrefix(identity.uid, pid)}${requestedMediaId ?? crypto.randomUUID()}`;
    const path = processMediaPath(key);
    if (!path) {
      return this.rejectResourceWrite(
        body,
        "Invalid process media path",
        "Process identity cannot own filesystem media",
      );
    }
    return {
      body,
      length: parsedLength.data,
      mimeType,
      pid,
      identity,
      lifecycleEpoch: this.host.lifecycleEpoch,
      requestedMediaId,
      key,
      path,
      descriptorId: await stableOpaqueId("process-media-descriptor", [
        args.type,
        mimeType,
        args.filename || null,
        args.duration ?? null,
        args.transcription || null,
      ]),
    };
  }

  private async reuseResourceWrite(
    args: StagedResourceWriteArgs,
    plan: ResourceWritePlan,
    signal: AbortSignal,
  ): Promise<StagedResourceWriteResult | null> {
    const existing = await this.host.storage.head(plan.key);
    if (!isCurrentMediaUpload(this.host, plan.pid, plan.identity.uid, plan.lifecycleEpoch)) {
      return this.rejectResourceWrite(plan.body, "Process reset during media upload");
    }
    if (!existing) return null;
    const existingMimeType = existing.httpMetadata?.contentType || "application/octet-stream";
    if (
      existing.size !== plan.length ||
      existingMimeType !== plan.mimeType ||
      existing.customMetadata?.descriptorId !== plan.descriptorId
    ) {
      return this.rejectResourceWrite(
        plan.body,
        "Process media id conflicts with existing media",
        "Resource id conflicts with existing media",
      );
    }
    try {
      await plan.body.stream.pipeTo(new WritableStream<Uint8Array>(), { signal });
    } catch (error) {
      if (signal.aborted) return resourceWriteFailure("Process reset during media upload");
      throw new Error(
        `Resource write failed to consume repeated media: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return isCurrentMediaUpload(this.host, plan.pid, plan.identity.uid, plan.lifecycleEpoch)
      ? {
          ok: true,
          media: outputMedia(args, plan.mimeType, plan.key, plan.path, existing.size),
        }
      : resourceWriteFailure("Process reset during media upload");
  }

  private async writeResource(
    args: StagedResourceWriteArgs,
    plan: ResourceWritePlan,
    signal: AbortSignal,
  ): Promise<StagedResourceWriteResult> {
    let object: R2Object;
    try {
      object = await this.storeExactObject(
        plan.key,
        plan.length,
        plan.body.stream,
        {
          httpMetadata: { contentType: plan.mimeType },
          customMetadata: {
            uid: String(plan.identity.uid),
            gid: String(plan.identity.gid),
            mode: "400",
            processId: plan.pid,
            descriptorId: plan.descriptorId,
          },
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) return resourceWriteFailure("Process reset during media upload");
      return resourceWriteFailure(
        `Resource write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isCurrentMediaUpload(this.host, plan.pid, plan.identity.uid, plan.lifecycleEpoch)) {
      await this.host.storage.delete(plan.key);
      return resourceWriteFailure("Process reset during media upload");
    }
    return {
      ok: true,
      media: outputMedia(args, plan.mimeType, plan.key, plan.path, object.size),
    };
  }

  async storeIncomingResource(
    args: StagedResourceWriteArgs,
    body?: FrameBody,
  ): Promise<StagedResourceWriteResult> {
    const plan = await this.prepareResourceWrite(args, body);
    if ("ok" in plan) return plan;
    const releaseMediaWrite = plan.requestedMediaId
      ? await this.acquireMediaKeyAdmission(plan.key)
      : null;
    let uploadController: AbortController | undefined;
    try {
      if (!isCurrentMediaUpload(this.host, plan.pid, plan.identity.uid, plan.lifecycleEpoch)) {
        return this.rejectResourceWrite(plan.body, "Process reset during media upload");
      }
      uploadController = new AbortController();
      this.host.mediaUploadAbortControllers.set(plan.key, uploadController);
      if (plan.requestedMediaId) {
        const reused = await this.reuseResourceWrite(args, plan, uploadController.signal);
        if (reused) return reused;
      }
      return await this.writeResource(args, plan, uploadController.signal);
    } finally {
      if (
        uploadController &&
        this.host.mediaUploadAbortControllers.get(plan.key) === uploadController
      ) {
        this.host.mediaUploadAbortControllers.delete(plan.key);
      }
      releaseMediaWrite?.();
    }
  }

  async handleProcessResourcesRetain(
    frame: ProcessResourcesRetainRequestFrame,
    signal: AbortSignal,
  ): Promise<ResourceBlock[]> {
    if (this.host.killed || !this.host.isInitialized()) {
      throw new Error("Process no longer exists");
    }
    const batchId = frame.args.batchId.trim();
    if (!batchId || batchId.length > 256) {
      throw new Error("Resource retention batch id is invalid");
    }
    if (frame.args.resources.length === 0) return [];
    if (frame.args.resources.length > MAX_MESSAGE_MEDIA_ITEMS) {
      throw new Error(`Resource batch exceeds ${MAX_MESSAGE_MEDIA_ITEMS} items`);
    }
    const resources = frame.args.resources.map((resource) => resourceBlockSchema.parse(resource));
    let totalBytes = 0;
    for (const resource of resources) {
      if (resource.ref.expiresAt !== undefined && resource.ref.expiresAt <= Date.now()) {
        throw new Error(`Resource has expired: ${resource.ref.path}`);
      }
      if (resource.ref.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
        throw new Error(`Resource exceeds the ${MAX_MESSAGE_MEDIA_PART_BYTES}-byte limit`);
      }
      totalBytes += resource.ref.size;
      if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
        throw new Error(`Resource batch exceeds the ${MAX_MESSAGE_MEDIA_TOTAL_BYTES}-byte limit`);
      }
    }
    const identity = this.host.identity;
    const lifecycleEpoch = this.host.lifecycleEpoch;
    const current = () => this.retentionIsCurrent(identity, lifecycleEpoch);
    const targetKeys = await Promise.all(
      resources.map(async (resource) => await this.resourceRetentionKey(resource)),
    );
    const keys = [...new Set(targetKeys.flatMap((key) => (key ? [key] : [])))].sort();
    const releaseMedia = await this.acquireMediaKeyAdmissions(keys);
    try {
      signal.throwIfAborted();
      if (!current()) throw new Error("Resource is no longer pending");
      const retained: ResourceBlock[] = [];
      const createdKeys: string[] = [];
      try {
        for (const [index, resource] of resources.entries()) {
          const result = await this.retainResource(resource, {
            signal,
            current,
            targetKey: targetKeys[index] ?? undefined,
            mediaAdmissionHeld: true,
          });
          retained.push(result.resource);
          if (result.createdKey) createdKeys.push(result.createdKey);
        }
        return retained;
      } catch (error) {
        if (createdKeys.length === 0) throw error;
        try {
          await this.host.storage.delete(createdKeys);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Resource batch ${batchId} failed and could not be rolled back`,
          );
        }
        throw error;
      }
    } finally {
      releaseMedia();
    }
  }

  async handleProcessResourceWrite(
    frame: ProcessResourceWriteRequestFrame,
  ): Promise<ResourceBlock> {
    const body = frame.body;
    if (body.length === undefined || body.length > MAX_MESSAGE_MEDIA_PART_BYTES) {
      await body.stream.cancel("Resource body length is invalid").catch(() => {});
      throw new Error(`Resource body must be at most ${MAX_MESSAGE_MEDIA_PART_BYTES} bytes`);
    }
    const result = await this.storeIncomingResource(
      {
        type: frame.args.mediaType,
        mimeType: frame.args.contentType,
        mediaId: frame.args.resourceId,
        filename: frame.args.filename,
        duration: frame.args.duration,
        transcription: frame.args.transcription,
      },
      body,
    );
    if (!result.ok) throw new Error(result.error);
    const sourceKey = result.media.key;
    if (!sourceKey) throw new Error("Stored resource has no key");
    try {
      const rewrites = await this.persistArchivedMediaKeys([sourceKey]);
      const rewrite = rewrites.get(sourceKey);
      if (!rewrite || "missing" in rewrite) {
        throw new Error("Stored resource disappeared before retention");
      }
      const object = await this.host.storage.head(rewrite.key);
      if (
        !object ||
        !this.isValidOwnedArchiveObject(rewrite.key, object, {
          expectedContentType: frame.args.contentType,
        })
      ) {
        throw new Error("Stored resource archive is invalid");
      }
      await this.host.storage.delete(sourceKey);
      return resourceBlockSchema.parse({
        type: "resource",
        ref: {
          type: "file",
          target: "gsv",
          path: rewrite.path,
          revision: object.httpEtag,
          contentType: frame.args.contentType,
          size: object.size,
        },
        mediaType: frame.args.mediaType,
        filename: frame.args.filename,
        duration: frame.args.duration,
        transcription: frame.args.transcription,
      });
    } catch (error) {
      await this.host.storage.delete(sourceKey).catch(() => {});
      throw error;
    }
  }

  private async prepareRunAttachments(
    input: ProcessRunAttachArgs["media"],
    runId: string,
    current: () => boolean,
  ): Promise<PreparedRunAttachments> {
    const media: RunOutputMedia[] = [];
    const resources: ResourceBlock[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const raw of input) {
      const parsed = resourceBlockSchema.safeParse(raw);
      if (!parsed.success) throw new Error("proc.run.attach media requires a valid resource");
      const item = parsed.data;
      if (!Number.isSafeInteger(item.ref.size) || item.ref.size < 0) {
        throw new Error("proc.run.attach media requires an exact size");
      }
      if (item.ref.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
        throw new Error(
          `proc.run.attach media exceeds per-item limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes)`,
        );
      }
      const sourceId = JSON.stringify([item.ref.target, item.ref.path, item.ref.revision]);
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      totalBytes += item.ref.size;
      if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
        throw new Error(
          `proc.run.attach media exceeds total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
        );
      }
      const resource = (
        await this.retainResource(item, {
          runId,
          signal: this.host.run.runAbortSignal(runId),
          current,
        })
      ).resource;
      const ref = resource.ref;
      media.push(
        outputMedia(
          {
            type: resource.mediaType ?? mediaTypeFromContentType(ref.contentType),
            filename: resource.filename?.trim() ? resource.filename : undefined,
            duration: resource.duration,
            transcription: resource.transcription?.trim() ? resource.transcription : undefined,
          },
          ref.contentType,
          ref.path.replace(/^\/+/, ""),
          ref.path,
          ref.size,
          ref.revision,
        ),
      );
      resources.push(resource);
    }
    return { media, resources };
  }

  async handleProcRunAttach(args: ProcessRunAttachArgs): Promise<ProcessRunAttachResult> {
    if (!this.host.isInitialized()) {
      return { ok: false, error: "Process no longer exists" };
    }
    const runId = args.runId.trim();
    if (!runId) {
      return { ok: false, error: "proc.run.attach requires runId" };
    }
    if (args.media.length === 0) {
      return { ok: false, error: "proc.run.attach requires media" };
    }
    if (args.media.length > MAX_MESSAGE_MEDIA_ITEMS) {
      return {
        ok: false,
        error: `proc.run.attach accepts at most ${MAX_MESSAGE_MEDIA_ITEMS} media items`,
      };
    }
    const identity = this.host.identity;
    const lifecycleEpoch = this.host.lifecycleEpoch;
    const current = () => this.retentionIsCurrent(identity, lifecycleEpoch, runId);
    if (!current()) {
      return { ok: false, error: "the process run is no longer active" };
    }
    let prepared: PreparedRunAttachments;
    try {
      prepared = await this.prepareRunAttachments(args.media, runId, current);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const { media: normalized, resources: retained } = prepared;

    const keys = normalized.map((item) => item.key).sort();
    const releaseMedia = await this.acquireMediaKeyAdmissions(keys);
    try {
      for (const item of normalized) {
        const object = await this.host.storage.head(item.key);
        if (!object) {
          return { ok: false, error: `media not found: ${item.key}` };
        }
        const storedMimeType = object.httpMetadata?.contentType || "application/octet-stream";
        if (object.size !== item.size || storedMimeType !== item.mimeType) {
          return {
            ok: false,
            error: `media descriptor does not match stored data: ${item.key}`,
          };
        }
      }

      return this.host.ctx.storage.transactionSync((): ProcessRunAttachResult => {
        if (!current()) {
          return { ok: false, error: "the process run is no longer active" };
        }
        const run = this.host.runs.active;
        if (!run || run.runId !== runId) {
          return { ok: false, error: "the process run is no longer active" };
        }
        const merged = new Map((run.outputMedia ?? []).map((item) => [item.key, item]));
        for (const item of normalized) {
          merged.set(item.key, item);
        }
        const media = [...merged.values()];
        const combinedBytes = media.reduce((sum, item) => sum + item.size, 0);
        if (media.length > MAX_MESSAGE_MEDIA_ITEMS) {
          return {
            ok: false,
            error: `proc.run.attach accepts at most ${MAX_MESSAGE_MEDIA_ITEMS} media items`,
          };
        }
        if (combinedBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
          return {
            ok: false,
            error: `proc.run.attach media exceeds total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
          };
        }

        run.outputMedia = media;
        delete run.outputMediaPersisted;
        this.host.runs.active = run;
        return { ok: true, runId, media: retained };
      });
    } finally {
      releaseMedia();
    }
  }

  runOutputMediaResource(media: RunOutputMedia): ResourceBlock {
    const path = agentArchiveMediaPath(this.host.identity.home, media.key);
    if (!path || path !== media.path || !media.revision) {
      throw new Error(`Reply media is not an immutable resource: ${media.key}`);
    }
    return resourceBlockSchema.parse({
      type: "resource",
      ref: {
        type: "file",
        target: "gsv",
        path,
        revision: media.revision,
        contentType: media.mimeType,
        size: media.size,
      },
      mediaType: media.type,
      filename: media.filename,
      duration: media.duration,
      transcription: media.transcription,
    });
  }

  ownedMediaPath(key: string): string | null {
    const activePath = processMediaPath(key);
    if (activePath && key.startsWith(processMediaPrefix(this.host.identity.uid, this.host.pid))) {
      return activePath;
    }
    return agentArchiveMediaPath(this.host.identity.home, key);
  }

  isValidOwnedArchiveObject(
    key: string,
    object: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
    },
    expected: { sourceEtag?: string; expectedContentType?: string } = {},
    identity = this.host.identity,
  ): boolean {
    if (!key.startsWith(agentArchiveMediaPrefix(identity.home))) return true;
    return isValidAgentArchiveMediaObject({
      home: identity.home,
      key,
      uid: identity.uid,
      gid: identity.gid,
      object,
      expectedSourceEtag: expected.sourceEtag,
      expectedContentType: expected.expectedContentType,
    });
  }

  parseOwnedProcessMedia(raw: string | null): StoredProcessMedia[] {
    return parseStoredProcessMedia(raw).map((item) => {
      const { path: _persistedPath, ...metadata } = item;
      const path = item.key ? this.ownedMediaPath(item.key) : null;
      return path ? { ...metadata, path } : metadata;
    });
  }

  activeProcessMediaKeys(messages: MessageRecord[]): string[] {
    const sourcePrefix = processMediaPrefix(this.host.identity.uid, this.host.pid);
    return [
      ...new Set(
        messages.flatMap((message) =>
          parseStoredProcessMedia(message.media).flatMap((media) =>
            media.key?.startsWith(sourcePrefix) && processMediaPath(media.key) ? [media.key] : [],
          ),
        ),
      ),
    ].sort();
  }

  async hydrateMediaContent(
    text: string,
    rawMedia: string,
    budget: { remainingBytes: number },
  ): Promise<Array<TextContent | ImageContent>> {
    const media = this.parseOwnedProcessMedia(rawMedia);
    const content: Array<TextContent | ImageContent> = [];

    if (text.trim().length > 0) {
      content.push({ type: "text", text });
    }

    for (const item of media) {
      content.push({
        type: "text",
        text: describeStoredProcessMedia(item),
      });

      if (item.type === "image" && item.key && !isVectorImageMimeType(item.mimeType)) {
        const data = await this.loadProcessMedia(item.key, item.mimeType, budget);
        if (data) {
          content.push(buildImageBlock(data, item.mimeType));
        }
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    return content;
  }

  async loadProcessMedia(
    key: string,
    expectedContentType: string,
    budget: { remainingBytes: number },
  ): Promise<string | null> {
    if (!this.ownedMediaPath(key)) {
      return null;
    }
    const object = await this.host.storage.get(key);
    if (!object) {
      return null;
    }
    if (this.host.killed) {
      await object.body.cancel("Process no longer exists").catch(() => {});
      return null;
    }
    if (
      !this.isValidOwnedArchiveObject(key, object, {
        expectedContentType,
      }) ||
      object.size > MAX_PROCESS_MEDIA_READ_BYTES ||
      object.size > budget.remainingBytes
    ) {
      await object.body.cancel("Process media cannot be hydrated").catch(() => {});
      return null;
    }

    budget.remainingBytes -= object.size;
    return encodeBase64Bytes(await object.arrayBuffer());
  }

  async persistArchivedMedia(
    messages: MessageRecord[],
    signal?: AbortSignal,
  ): Promise<Map<string, ArchivedMediaRewrite>> {
    const sourceKeys = this.activeProcessMediaKeys(messages);
    return this.persistArchivedMediaKeys(sourceKeys, signal);
  }

  async persistArchivedMediaKeys(
    sourceKeys: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ArchivedMediaRewrite>> {
    const rewrites = new Map<string, ArchivedMediaRewrite>();
    const identity = this.host.identity;
    const archivePrefix = agentArchiveMediaPrefix(identity.home);

    for (const sourceKey of [...new Set(sourceKeys)].sort()) {
      signal?.throwIfAborted();
      const sourceHead = await this.host.storage.head(sourceKey);
      if (!sourceHead) {
        rewrites.set(sourceKey, { missing: true });
        continue;
      }
      const archiveId = await stableOpaqueId("archived-media", [sourceKey, sourceHead.etag]);
      const archivedKey = `${archivePrefix}${archiveId}`;
      const sourceContentType =
        sourceHead.httpMetadata?.contentType?.trim() || "application/octet-stream";
      const sourceReference = {
        size: sourceHead.size,
        revision: sourceHead.etag,
        contentType: sourceContentType,
      };
      let archived = await this.host.storage.head(archivedKey);
      const reusable = this.retainedObjectMatches(archivedKey, archived, sourceReference, identity);
      if (archived && !reusable) {
        throw new Error(`archived media content-address collision: ${archivedKey}`);
      }
      if (!archived) {
        signal?.throwIfAborted();
        const source = await this.host.storage.get(sourceKey);
        if (!source) {
          rewrites.set(sourceKey, { missing: true });
          continue;
        }
        if (
          source.etag !== sourceHead.etag ||
          source.size !== sourceHead.size ||
          (source.httpMetadata?.contentType?.trim() || "application/octet-stream") !==
            sourceContentType
        ) {
          await source.body.cancel("Process media changed while archiving").catch(() => {});
          throw new Error(`media changed while archiving: ${sourceKey}`);
        }
        if (signal?.aborted) {
          await source.body.cancel(signal.reason).catch(() => {});
          signal.throwIfAborted();
        }
        const copied = await this.storeExactObject(
          archivedKey,
          sourceHead.size,
          source.body,
          {
            httpMetadata: {
              ...sourceHead.httpMetadata,
              contentType: sourceContentType,
            },
            customMetadata: {
              uid: String(identity.uid),
              gid: String(identity.gid),
              mode: "400",
              purpose: "conversation-media",
              sourceEtag: sourceHead.etag,
              sourceContentType,
            },
          },
          signal,
        );
        if (!this.retainedObjectMatches(archivedKey, copied, sourceReference, identity)) {
          throw new Error(`failed to verify archived media: ${archivedKey}`);
        }
        archived = copied;
      }
      rewrites.set(sourceKey, {
        key: archivedKey,
        path: `/${archivedKey}`,
        revision: archived.httpEtag,
      });
    }

    return rewrites;
  }

  async prepareToolResultForStorage(
    runId: string,
    executionId: string,
    result: Parameters<typeof jsonValueSchema.safeParse>[0],
  ): Promise<{ value: JsonValue; createdKeys: string[] }> {
    const lifecycleEpoch = this.host.lifecycleEpoch;
    const signal = this.host.run.runAbortSignal(runId);
    const parsedResult = jsonValueSchema.parse(result ?? null);
    const pending = this.host.store.tools.getPending(executionId);
    const sourceResource = pending?.call === "fs.read" ? extractFsReadResource(parsedResult) : null;
    if (sourceResource) {
      const retained = await this.retainFileResource(runId, executionId, sourceResource);
      return {
        value: jsonValueSchema.parse(
          wrapStoredToolResult(replaceFsReadResource(parsedResult, retained.ref), [retained.media]),
        ),
        createdKeys: [],
      };
    }
    const extracted = extractToolResultImages(parsedResult, {
      maxImages: MAX_MESSAGE_MEDIA_ITEMS,
      maxBytes: MAX_PROCESS_MEDIA_READ_BYTES,
    });
    if (extracted.images.length === 0) {
      return { value: parsedResult, createdKeys: [] };
    }
    const createdKeys: string[] = [];
    const media: StoredProcessMedia[] = [];

    try {
      for (const image of extracted.images) {
        signal.throwIfAborted();
        if (
          this.host.killed ||
          this.host.lifecycleEpoch !== lifecycleEpoch ||
          this.host.store.tools.getPending(executionId)?.runId !== runId
        ) {
          throw new Error("Tool result is no longer pending");
        }

        const key = `${processMediaPrefix(this.host.identity.uid, this.host.pid)}tool-result:${crypto.randomUUID()}`;
        const path = processMediaPath(key);
        if (!path) {
          throw new Error("Process identity cannot own tool result media");
        }
        createdKeys.push(key);
        const stored = await this.host.storage.put(key, image.bytes, {
          httpMetadata: { contentType: image.mimeType },
          customMetadata: {
            uid: String(this.host.identity.uid),
            gid: String(this.host.identity.gid),
            mode: "400",
            processId: this.host.pid,
            purpose: "tool-result-media",
          },
        });
        if (stored.size !== image.bytes.byteLength) {
          throw new Error("Stored tool result image length did not match its source");
        }
        image.placeholder.path = path;
        image.placeholder.size = stored.size;
        media.push({
          type: "image",
          mimeType: image.mimeType,
          key,
          path,
          size: stored.size,
        });
      }

      signal.throwIfAborted();
      if (
        this.host.killed ||
        this.host.lifecycleEpoch !== lifecycleEpoch ||
        this.host.store.tools.getPending(executionId)?.runId !== runId
      ) {
        throw new Error("Tool result is no longer pending");
      }
      return {
        value: jsonValueSchema.parse(wrapStoredToolResult(extracted.output, media)),
        createdKeys,
      };
    } catch (error) {
      await this.deletePreparedToolResultMedia(createdKeys);
      throw error;
    }
  }

  async retainFileResource(
    runId: string,
    executionId: string,
    source: FileResourceReference,
  ): Promise<{ ref: FileResourceReference; media: StoredProcessMedia }> {
    const signal = this.host.run.runAbortSignal(runId);
    signal.throwIfAborted();
    if (
      !source.contentType.toLowerCase().startsWith("image/") ||
      isVectorImageMimeType(source.contentType)
    ) {
      throw new Error(`Unsupported resource content type: ${source.contentType}`);
    }
    const { resource } = await this.retainResource(
      {
        type: "resource",
        ref: source,
        mediaType: "image",
      },
      {
        runId,
        signal,
        current: () =>
          !this.host.handleRunStopped(runId) &&
          this.host.store.tools.getPending(executionId)?.runId === runId,
      },
    );
    const key = resource.ref.path.replace(/^\/+/, "");
    return {
      ref: resource.ref,
      media: {
        type: "image",
        mimeType: resource.ref.contentType,
        key,
        path: resource.ref.path,
        size: resource.ref.size,
      },
    };
  }

  async retainResource(
    resource: ResourceBlock,
    options: ResourceRetentionOptions,
  ): Promise<ResourceRetentionResult> {
    const source = resource.ref;
    this.validateResourceRetention(source, options);
    const owned = await this.resolveOwnedArchiveResource(resource);
    if (owned) {
      this.assertRetentionPending(options);
      return { resource: owned };
    }
    const identity = this.host.identity;
    const key = options.targetKey ?? (await this.resourceRetentionKey(resource));
    if (!key) throw new Error(`Resource retention target is invalid: ${source.path}`);
    const path = `/${key}`;
    const releaseMedia = options.mediaAdmissionHeld
      ? null
      : await this.acquireMediaKeyAdmissions([key]);
    let createdObject = false;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    try {
      this.assertRetentionPending(options);
      let archived = await this.host.storage.head(key);
      this.assertRetentionPending(options);
      if (archived) {
        if (!this.retainedObjectMatches(key, archived, source)) {
          throw new Error(`Retained resource collision: ${path}`);
        }
        return {
          resource: retainedResourceBlock(resource, path, archived.httpEtag),
        };
      }

      const body = await this.requestResourceBody(source, options);
      responseBody = body.stream;
      archived = await this.storeExactObject(
        key,
        source.size,
        body.stream,
        {
          httpMetadata: { contentType: source.contentType },
          customMetadata: {
            uid: String(identity.uid),
            gid: String(identity.gid),
            mode: "400",
            purpose: "resource",
            sourceEtag: source.revision,
            sourceContentType: source.contentType,
          },
        },
        options.signal,
      );
      createdObject = true;
      this.assertRetentionPending(options);
      if (!this.retainedObjectMatches(key, archived, source)) {
        throw new Error(`Failed to verify retained resource: ${path}`);
      }
      return {
        resource: retainedResourceBlock(resource, path, archived.httpEtag),
        createdKey: key,
      };
    } catch (error) {
      await responseBody?.cancel(error).catch(() => {});
      if (createdObject) {
        try {
          await this.host.storage.delete(key);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Resource retention failed and ${key} could not be removed`,
          );
        }
      }
      throw error;
    } finally {
      releaseMedia?.();
    }
  }

  async resolveOwnedArchiveResource(resource: ResourceBlock): Promise<ResourceBlock | null> {
    const source = resource.ref;
    const sourceKey = source.path.replace(/^\/+/, "");
    if (
      source.target !== "gsv" ||
      source.path !== agentArchiveMediaPath(this.host.identity.home, sourceKey)
    ) {
      return null;
    }
    const archived = await this.host.storage.head(sourceKey);
    if (
      !archived ||
      archived.size !== source.size ||
      archived.httpEtag !== source.revision ||
      !this.isValidOwnedArchiveObject(sourceKey, archived, {
        expectedContentType: source.contentType,
      })
    ) {
      throw new Error(`Owned resource does not match its immutable reference: ${source.path}`);
    }
    return resource;
  }

  async resourceRetentionKey(resource: ResourceBlock): Promise<string | null> {
    const source = resource.ref;
    const sourceKey = source.path.replace(/^\/+/, "");
    if (
      source.target === "gsv" &&
      source.path === agentArchiveMediaPath(this.host.identity.home, sourceKey)
    ) {
      return null;
    }
    return `${agentArchiveMediaPrefix(this.host.identity.home)}${await stableOpaqueId("archived-media", [
      this.host.pid,
      source.target,
      source.path,
      source.revision,
    ])}`;
  }

  async deletePreparedToolResultMedia(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.host.storage.delete(keys);
    } catch {
      console.warn(
        `[Process] Failed to clean ${keys.length} unreferenced tool result media object(s)`,
      );
    }
  }

  async deleteUnreferencedActiveMedia(keys: string[]): Promise<void> {
    const candidates = [...new Set(keys)].sort();
    if (candidates.length === 0) return;

    const releaseMedia = await this.acquireMediaKeyAdmissions(candidates);
    try {
      if (this.host.killed || this.host.lifecyclePhase !== "ready") return;
      const prefix = processMediaPrefix(this.host.identity.uid, this.host.pid);
      const unreferenced = candidates.filter(
        (key) =>
          key.startsWith(prefix) &&
          processMediaPath(key) !== null &&
          !this.host.store.messages.referencesMediaKey(key) &&
          !this.host.runs.active?.outputMedia?.some((item) => item.key === key),
      );
      if (unreferenced.length > 0) await this.host.storage.delete(unreferenced);
    } finally {
      releaseMedia();
    }
  }

  async promoteRunOutputMedia(runId: string): Promise<RunOutputMedia[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = this.host.runs.active;
      if (!run || run.runId !== runId) return [];
      const snapshot = [...(run.outputMedia ?? [])];
      const sourcePrefix = processMediaPrefix(this.host.identity.uid, this.host.pid);
      const sourceKeys = snapshot.flatMap((item) =>
        item.key.startsWith(sourcePrefix) && processMediaPath(item.key) ? [item.key] : [],
      );
      const releaseMedia = await this.acquireMediaKeyAdmissions(sourceKeys);
      try {
        const rewrites =
          sourceKeys.length > 0
            ? await this.persistArchivedMediaKeys(sourceKeys, this.host.run.runAbortSignal(runId))
            : new Map<string, ArchivedMediaRewrite>();
        const promoted = await Promise.all(
          snapshot
            .map(async (item): Promise<RunOutputMedia> => {
              const rewrite = rewrites.get(item.key);
              if (!rewrite) return item;
              if ("missing" in rewrite) {
                throw new Error(`reply media not found while finalizing: ${item.key}`);
              }
              return { ...item, ...rewrite };
            })
            .map(async (pending) => {
              const item = await pending;
              if (item.revision) return item;
              const object = await this.host.storage.head(item.key);
              if (
                !object ||
                object.size !== item.size ||
                !this.isValidOwnedArchiveObject(item.key, object, {
                  expectedContentType: item.mimeType,
                })
              ) {
                throw new Error(`reply media archive is invalid: ${item.key}`);
              }
              return { ...item, revision: object.httpEtag };
            }),
        );

        if (this.host.handleRunStopped(runId)) return [];
        const retry = this.host.ctx.storage.transactionSync(() => {
          const activeRun = this.host.runs.active;
          if (!activeRun || activeRun.runId !== runId) return false;
          if (JSON.stringify(activeRun.outputMedia ?? []) !== JSON.stringify(snapshot)) {
            return true;
          }
          activeRun.outputMedia = promoted;
          this.host.runs.active = activeRun;
          return false;
        });
        if (!retry) return promoted;
      } finally {
        releaseMedia();
      }
    }
    throw new Error("reply media changed repeatedly while finalizing");
  }
}
