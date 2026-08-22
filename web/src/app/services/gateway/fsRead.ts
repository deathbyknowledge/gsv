import type { GSVClient, GsvBody } from "@humansandmachines/gsv/client";
import { z } from "zod";
import {
  bodyToBytes,
  bodyToText,
  type FsReadResult,
} from "@humansandmachines/gsv/protocol";

export type FsReadClient = Pick<GSVClient, "request">;

type FsReadFileResult = Extract<FsReadResult, { kind: "text" | "image" }>;
const fsReadArgsSchema = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});
type FsReadImageContent = [
  { type: "text"; text: string },
  { type: "image"; data: string; mimeType: string },
];

export type MaterializedFsReadResult =
  | Exclude<FsReadResult, FsReadFileResult>
  | (Omit<FsReadFileResult, "kind"> & { kind: "text"; content: string })
  | (Omit<FsReadFileResult, "kind"> & { kind: "image"; content: FsReadImageContent });

export async function requestFsRead<T>(
  client: FsReadClient,
  args: T,
): Promise<MaterializedFsReadResult> {
  const parsedArgs = fsReadArgsSchema.safeParse(args);
  if (!parsedArgs.success) {
    throw new Error("fs.read requires a valid path");
  }
  const { data, body } = await client.request<FsReadResult>("fs.read", parsedArgs.data);
  return await materializeFsRead(data, body);
}

export async function materializeFsRead(
  data: FsReadResult,
  body?: GsvBody,
): Promise<MaterializedFsReadResult> {
  if (!isFileResult(data)) {
    if (body) {
      await body.stream.cancel().catch(() => {});
      throw new Error("fs.read returned a body without file metadata");
    }
    return data;
  }
  if (!body) {
    throw new Error("fs.read file response did not include a body");
  }

  if (data.kind === "text") {
    return { ...data, kind: "text", content: await bodyToText(body) };
  }

  const bytes = await bodyToBytes(body);
  return {
    ...data,
    kind: "image",
    content: [
      {
        type: "text",
        text: `Read image ${data.path} [${data.contentType}, ${formatSize(data.size)}]`,
      },
      { type: "image", data: encodeBase64(bytes), mimeType: data.contentType },
    ],
  };
}

function isFileResult(data: FsReadResult): data is FsReadFileResult {
  return data.ok && "kind" in data;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
