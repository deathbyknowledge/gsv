import { env } from "cloudflare:workers";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import { getDefaultAgentId } from "../../config/parsing";
import {
  listFiles,
  readFile,
  writeFile,
  deleteFile,
} from "../../agents/tools/workspace";
import type { Gateway } from "../do";

function resolveBasePath(gw: Gateway, agentId?: string): string {
  const id = agentId || getDefaultAgentId(gw.getConfig());
  return `agents/${id}`;
}

export const handleWorkspaceList: Handler<"workspace.list"> = async ({
  gw,
  params,
}) => {
  const basePath = resolveBasePath(gw, params?.agentId);
  const result = await listFiles(env.STORAGE, basePath, params?.path);
  if (!result.ok) {
    throw new RpcError(500, result.error || "Failed to list files");
  }
  return result.result as {
    path: string;
    files: string[];
    directories: string[];
  };
};

export const handleWorkspaceRead: Handler<"workspace.read"> = async ({
  gw,
  params,
}) => {
  if (!params?.path) {
    throw new RpcError(400, "path is required");
  }
  const basePath = resolveBasePath(gw, params?.agentId);
  const result = await readFile(env.STORAGE, basePath, params.path);
  if (!result.ok) {
    throw new RpcError(404, result.error || "File not found");
  }
  return result.result as {
    path: string;
    content: string;
    size: number;
    lastModified?: string;
  };
};

export const handleWorkspaceWrite: Handler<"workspace.write"> = async ({
  gw,
  params,
}) => {
  if (!params?.path) {
    throw new RpcError(400, "path is required");
  }
  if (params.content === undefined || params.content === null) {
    throw new RpcError(400, "content is required");
  }
  const basePath = resolveBasePath(gw, params?.agentId);
  const result = await writeFile(
    env.STORAGE,
    basePath,
    params.path,
    params.content,
  );
  if (!result.ok) {
    throw new RpcError(500, result.error || "Failed to write file");
  }
  return result.result as {
    path: string;
    size: number;
    written: true;
  };
};

export const handleWorkspaceDelete: Handler<"workspace.delete"> = async ({
  gw,
  params,
}) => {
  if (!params?.path) {
    throw new RpcError(400, "path is required");
  }
  const basePath = resolveBasePath(gw, params?.agentId);
  const result = await deleteFile(env.STORAGE, basePath, params.path);
  if (!result.ok) {
    throw new RpcError(404, result.error || "File not found");
  }
  return result.result as {
    path: string;
    deleted: true;
  };
};
