import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  FsTransferReceiveResult,
  FsTransferStatResult,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";

import { frameBodyFromBlob } from "./frameBody";

export type StagedResourceUpload = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  filename?: string;
  duration?: number;
  transcription?: string;
  body: Blob;
};

export const MAX_STAGED_RESOURCE_BYTES = 25 * 1024 * 1024;

type ResourceUploadClient = Pick<GSVClient, "request">;
type FailureResult = { ok: false; error: string };

export async function withStagedResources<T>(
  client: ResourceUploadClient,
  uploads: readonly StagedResourceUpload[],
  operation: (resources: ResourceBlock[]) => Promise<T>,
  stagingNamespace: string = crypto.randomUUID(),
): Promise<T> {
  if (uploads.some(({ body }) => body.size > MAX_STAGED_RESOURCE_BYTES)) {
    throw new Error("Attachments cannot exceed 25 MiB");
  }
  const paths: string[] = [];
  const settled = await Promise.allSettled(uploads.map(async (upload, index) => {
    const path = uploadPath(stagingNamespace, index, upload.filename);
    paths.push(path);
    return uploadResource(client, path, upload);
  }));
  const resources = settled.flatMap((result) => (
    result.status === "fulfilled" ? [result.value] : []
  ));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    await deleteUploads(client, paths);
    throw failure.reason;
  }
  try {
    return await operation(resources);
  } finally {
    await deleteUploads(client, paths);
  }
}

async function uploadResource(
  client: ResourceUploadClient,
  path: string,
  upload: StagedResourceUpload,
): Promise<ResourceBlock> {
  const received = await client.request("fs.transfer.receive", {
    path,
    contentType: upload.mimeType,
  }, { body: frameBodyFromBlob(upload.body) });
  await received.body?.stream.cancel("fs.transfer.receive does not return a body").catch(() => {});
  const receiveResult = requireSuccess<Extract<FsTransferReceiveResult, { ok: true }>>(
    received.data,
  );
  if (receiveResult.bytesWritten !== upload.body.size) {
    throw new Error("GSV stored an unexpected attachment length");
  }
  const stat = await client.request("fs.transfer.stat", { path: receiveResult.path });
  await stat.body?.stream.cancel("fs.transfer.stat does not return a body").catch(() => {});
  const statResult = requireSuccess<Extract<FsTransferStatResult, { ok: true }>>(stat.data);
  if (
    !statResult.isFile
    || statResult.size !== upload.body.size
    || statResult.contentType !== upload.mimeType
    || !statResult.revision
  ) {
    throw new Error("GSV could not identify the uploaded attachment revision");
  }
  return {
    type: "resource",
    ref: {
      type: "file",
      target: "gsv",
      path: statResult.path,
      revision: statResult.revision,
      contentType: upload.mimeType,
      size: statResult.size,
    },
    mediaType: upload.type,
    ...(upload.filename ? { filename: upload.filename } : undefined),
    ...(upload.duration !== undefined ? { duration: upload.duration } : undefined),
    ...(upload.transcription ? { transcription: upload.transcription } : undefined),
  };
}

function uploadPath(namespace: string, index: number, filename: string | undefined): string {
  const safeNamespace = namespace.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  if (!safeNamespace) throw new Error("Staged resource namespace is invalid");
  const safe = filename?.trim().replaceAll(/[/\\\0]/g, "_") || "attachment";
  return `~/.gsv/uploads/${safeNamespace}/${index}-${safe}`;
}

async function deleteUploads(client: ResourceUploadClient, paths: string[]): Promise<void> {
  await Promise.allSettled(paths.map(async (path) => {
    const response = await client.request("fs.delete", { path });
    await response.body?.stream.cancel("fs.delete does not return a body").catch(() => {});
  }));
}

function requireSuccess<T extends { ok: true }>(result: T | FailureResult): T {
  if (!result.ok) throw new Error(result.error || "GSV resource request failed");
  return result;
}
