/*
 * Workspace Tools - Native R2 tools for agent workspace access
 *
 * These tools allow agents to read/write their own workspace files
 * directly through R2, without requiring a connected node.
 *
 * Tools are prefixed with "gsv__" to distinguish from node-provided tools.
 * The agent's workspace is scoped to: agents/{agentId}/
 */

import { NATIVE_TOOLS } from "./constants";
import type { ToolDefinition } from "../../protocol/tools";
import type { NativeToolHandlerMap } from "./types";

const VIRTUAL_SKILLS_ROOT = "skills";

export const getWorkspaceToolDefinitions = (): ToolDefinition[] => [
  {
    name: NATIVE_TOOLS.LIST_FILES,
    description:
      "List files and directories in your workspace. Your workspace persists across sessions and contains your identity files (SOUL.md, IDENTITY.md, etc.), memory files, and any other files you create. You can also list under skills/ to browse skill files (agent overrides + global fallback).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to workspace root (e.g., '/' for root, 'memory/' for memory directory, or 'skills/' for skill files). Defaults to '/'.",
        },
      },
      required: [],
    },
  },
  {
    name: NATIVE_TOOLS.READ_FILE,
    description:
      "Read a file from your workspace. Use this to read your identity files, memory files, or any files you've created. Reading skills/* first checks agent overrides under agents/{agentId}/skills/*, then falls back to global skills/*.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path relative to workspace root (e.g., 'SOUL.md', 'memory/2024-01-15.md', or 'skills/summarize/SKILL.md')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: NATIVE_TOOLS.WRITE_FILE,
    description:
      "Write or update a file in your workspace. Use this to update your identity (SOUL.md, IDENTITY.md), create memory files, or store any data you need to persist. Creates parent directories automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path relative to workspace root (e.g., 'SOUL.md', 'memory/2024-01-15.md')",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: NATIVE_TOOLS.DELETE_FILE,
    description:
      "Delete a file from your workspace. Use with caution - deleted files cannot be recovered.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path relative to workspace root (e.g., 'BOOTSTRAP.md')",
        },
      },
      required: ["path"],
    },
  },
];

/**
 * Normalize and validate a path within the workspace
 */
function normalizePath(
  basePath: string,
  relativePath: string | undefined,
): string {
  const path = normalizeRelativePath(relativePath, "");

  // Construct full path
  return path ? `${basePath}/${path}` : basePath;
}

function normalizeRelativePath(
  relativePath: string | undefined,
  defaultPath: string,
): string {
  // Default to root
  let path = (relativePath || defaultPath).trim();

  // Keep "/" as root
  if (path === "/") {
    path = "";
  }

  // Remove leading slash for R2 path construction
  if (path.startsWith("/")) {
    path = path.replace(/^\/+/, "");
  }

  // Remove trailing slashes except for root
  if (path.endsWith("/")) {
    path = path.replace(/\/+$/, "");
  }

  // Prevent path traversal
  if (path.includes("..")) {
    throw new Error("Path traversal not allowed");
  }

  return path;
}

function isVirtualSkillsPath(path: string): boolean {
  return (
    path === VIRTUAL_SKILLS_ROOT || path.startsWith(`${VIRTUAL_SKILLS_ROOT}/`)
  );
}

function toAgentSkillPath(basePath: string, skillPath: string): string {
  const suffix = skillPath.slice(`${VIRTUAL_SKILLS_ROOT}/`.length);
  return suffix
    ? `${basePath}/${VIRTUAL_SKILLS_ROOT}/${suffix}`
    : `${basePath}/${VIRTUAL_SKILLS_ROOT}`;
}

function toGlobalSkillPath(skillPath: string): string {
  return skillPath;
}

type R2Listed = {
  objects?: Array<{ key: string }>;
  delimitedPrefixes?: string[];
};

function collectVirtualSkillEntries(
  listed: R2Listed,
  prefix: string,
): {
  files: string[];
  directories: string[];
} {
  const files: string[] = [];
  const directories: string[] = [];

  for (const obj of listed.objects || []) {
    if (!obj.key.startsWith(prefix)) {
      continue;
    }
    const suffix = obj.key.slice(prefix.length);
    if (suffix) {
      files.push(suffix);
    }
  }

  for (const delimitedPrefix of listed.delimitedPrefixes || []) {
    if (!delimitedPrefix.startsWith(prefix)) {
      continue;
    }
    const suffix = delimitedPrefix.slice(prefix.length);
    if (suffix) {
      directories.push(suffix);
    }
  }

  return { files, directories };
}

function materializeVirtualSkillEntries(
  entries: { files: string[]; directories: string[] },
  virtualPath: string,
): { files: string[]; directories: string[] } {
  const virtualBase = `${virtualPath}/`;
  const files: string[] = [];
  const directories: string[] = [];

  for (const file of entries.files) {
    files.push(`${virtualBase}${file}`);
  }

  for (const directory of entries.directories) {
    directories.push(`${virtualBase}${directory}`);
  }

  return { files, directories };
}

async function listVirtualSkills(
  bucket: R2Bucket,
  basePath: string,
  virtualPath: string,
): Promise<{ files: string[]; directories: string[] }> {
  const skillSuffix =
    virtualPath === VIRTUAL_SKILLS_ROOT
      ? ""
      : virtualPath.slice(`${VIRTUAL_SKILLS_ROOT}/`.length);
  const agentPrefix = skillSuffix
    ? `${basePath}/${VIRTUAL_SKILLS_ROOT}/${skillSuffix}/`
    : `${basePath}/${VIRTUAL_SKILLS_ROOT}/`;
  const globalPrefix = skillSuffix
    ? `${VIRTUAL_SKILLS_ROOT}/${skillSuffix}/`
    : `${VIRTUAL_SKILLS_ROOT}/`;

  const [agentListed, globalListed] = await Promise.all([
    bucket.list({
      prefix: agentPrefix,
      delimiter: "/",
    }),
    bucket.list({
      prefix: globalPrefix,
      delimiter: "/",
    }),
  ]);

  const agentEntries = materializeVirtualSkillEntries(
    collectVirtualSkillEntries(agentListed as R2Listed, agentPrefix),
    virtualPath,
  );
  const globalEntries = materializeVirtualSkillEntries(
    collectVirtualSkillEntries(globalListed as R2Listed, globalPrefix),
    virtualPath,
  );

  // Agent skill files override global files with the same virtual path.
  const files = Array.from(
    new Set([...agentEntries.files, ...globalEntries.files]),
  );
  const directories = Array.from(
    new Set([...agentEntries.directories, ...globalEntries.directories]),
  );

  return { files, directories };
}

async function readVirtualSkillFile(
  bucket: R2Bucket,
  basePath: string,
  virtualPath: string,
): Promise<
  | {
      source: "agent";
      resolvedPath: string;
      content: string;
      size: number;
      lastModified?: string;
    }
  | {
      source: "global";
      resolvedPath: string;
      content: string;
      size: number;
      lastModified?: string;
    }
  | null
> {
  if (virtualPath === VIRTUAL_SKILLS_ROOT) {
    return null;
  }

  const agentPath = toAgentSkillPath(basePath, virtualPath);
  const agentObject = await bucket.get(agentPath);
  if (agentObject) {
    return {
      source: "agent",
      resolvedPath: agentPath,
      content: await agentObject.text(),
      size: agentObject.size,
      lastModified: agentObject.uploaded?.toISOString(),
    };
  }

  const globalPath = toGlobalSkillPath(virtualPath);
  const globalObject = await bucket.get(globalPath);
  if (globalObject) {
    return {
      source: "global",
      resolvedPath: globalPath,
      content: await globalObject.text(),
      size: globalObject.size,
      lastModified: globalObject.uploaded?.toISOString(),
    };
  }

  return null;
}

/**
 * List files in a directory
 */
export async function listFiles(
  bucket: R2Bucket,
  basePath: string,
  relativePath?: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const normalizedPath = normalizeRelativePath(relativePath, "");
  if (isVirtualSkillsPath(normalizedPath)) {
    const listed = await listVirtualSkills(bucket, basePath, normalizedPath);
    return {
      ok: true,
      result: {
        path: relativePath || "/",
        files: listed.files,
        directories: listed.directories,
      },
    };
  }

  const fullPath = normalizePath(basePath, normalizedPath);
  const prefix = fullPath.endsWith("/") ? fullPath : `${fullPath}/`;

  // List objects with this prefix
  const listed = await bucket.list({
    prefix: fullPath === basePath ? `${basePath}/` : prefix,
    delimiter: "/",
  });

  // Extract file names and directories
  const files: string[] = [];
  const directories: string[] = [];

  // Files (objects)
  for (const obj of listed.objects) {
    // Get relative path from workspace root
    const relPath = obj.key.replace(`${basePath}/`, "");
    if (relPath) {
      files.push(relPath);
    }
  }

  // Directories (common prefixes)
  for (const prefix of listed.delimitedPrefixes || []) {
    const relPath = prefix.replace(`${basePath}/`, "");
    if (relPath) {
      directories.push(relPath);
    }
  }

  return {
    ok: true,
    result: {
      path: relativePath || "/",
      files,
      directories,
    },
  };
}

/**
 * Read a file
 */
export async function readFile(
  bucket: R2Bucket,
  basePath: string,
  relativePath: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!relativePath) {
    return { ok: false, error: "path is required" };
  }

  const normalizedPath = normalizeRelativePath(relativePath, "");
  if (!normalizedPath) {
    return { ok: false, error: "path is required" };
  }

  if (isVirtualSkillsPath(normalizedPath)) {
    const resolved = await readVirtualSkillFile(
      bucket,
      basePath,
      normalizedPath,
    );
    if (!resolved) {
      return { ok: false, error: `File not found: ${relativePath}` };
    }

    return {
      ok: true,
      result: {
        path: relativePath,
        content: resolved.content,
        size: resolved.size,
        lastModified: resolved.lastModified,
        resolvedPath: resolved.resolvedPath,
        resolvedSource: resolved.source,
      },
    };
  }

  const fullPath = normalizePath(basePath, normalizedPath);
  const object = await bucket.get(fullPath);

  if (!object) {
    return { ok: false, error: `File not found: ${relativePath}` };
  }

  const content = await object.text();

  return {
    ok: true,
    result: {
      path: relativePath,
      content,
      size: object.size,
      lastModified: object.uploaded?.toISOString(),
    },
  };
}

/**
 * Write a file
 */
export async function writeFile(
  bucket: R2Bucket,
  basePath: string,
  relativePath: string,
  content: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!relativePath) {
    return { ok: false, error: "path is required" };
  }
  if (content === undefined || content === null) {
    return { ok: false, error: "content is required" };
  }

  const fullPath = normalizePath(basePath, relativePath);

  // Determine content type based on extension
  let contentType = "text/plain";
  if (relativePath.endsWith(".md")) {
    contentType = "text/markdown";
  } else if (relativePath.endsWith(".json")) {
    contentType = "application/json";
  } else if (relativePath.endsWith(".yaml") || relativePath.endsWith(".yml")) {
    contentType = "text/yaml";
  }

  await bucket.put(fullPath, content, {
    httpMetadata: {
      contentType,
    },
  });

  console.log(`[WorkspaceTools] Wrote ${fullPath} (${content.length} bytes)`);

  return {
    ok: true,
    result: {
      path: relativePath,
      size: content.length,
      written: true,
    },
  };
}

/**
 * Delete a file
 */
export async function deleteFile(
  bucket: R2Bucket,
  basePath: string,
  relativePath: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!relativePath) {
    return { ok: false, error: "path is required" };
  }

  const fullPath = normalizePath(basePath, relativePath);

  // Check if file exists first
  const existing = await bucket.head(fullPath);
  if (!existing) {
    return { ok: false, error: `File not found: ${relativePath}` };
  }

  await bucket.delete(fullPath);

  console.log(`[WorkspaceTools] Deleted ${fullPath}`);

  return {
    ok: true,
    result: {
      path: relativePath,
      deleted: true,
    },
  };
}

export const workspaceNativeToolHandlers: NativeToolHandlerMap = {
  [NATIVE_TOOLS.LIST_FILES]: async (context, args) =>
    await listFiles(context.bucket, context.basePath, args.path as string | undefined),
  [NATIVE_TOOLS.READ_FILE]: async (context, args) =>
    await readFile(context.bucket, context.basePath, args.path as string),
  [NATIVE_TOOLS.WRITE_FILE]: async (context, args) =>
    await writeFile(
      context.bucket,
      context.basePath,
      args.path as string,
      args.content as string,
    ),
  [NATIVE_TOOLS.DELETE_FILE]: async (context, args) =>
    await deleteFile(context.bucket, context.basePath, args.path as string),
};
