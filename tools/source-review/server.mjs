import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Ajv from "ajv";

const execFileAsync = promisify(execFile);
const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TOOL_ROOT, "../..");
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();
const ajv = new Ajv({ allErrors: true });
const validateFileWrite = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["workspace", "path", "content", "expectedHash"],
  properties: {
    workspace: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    content: { type: "string" },
    expectedHash: { type: "string", minLength: 1 },
  },
});
const validateMarkdownRender = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: {
    content: { type: "string" },
  },
});

const PROMPT_GROUPS = [
  {
    id: "system",
    label: "SYSTEM CONTEXT DEFAULTS",
    tone: "system",
    entries: [
      ["system.ts", "GSV_RUNTIME_FACTS"],
      ["system.ts", "GSV_RUNTIME_CONTEXT"],
      ["system.ts", "GSV_TARGET_CONTEXT"],
      ["system.ts", "GSV_RESPONSIBILITY_CONTEXT"],
      ["system.ts", "GSV_CONTEXT_DISCOVERY"],
      ["system.ts", "GSV_PROCESS_ORCHESTRATION"],
    ],
  },
  {
    id: "personal",
    label: "FRESH PERSONAL INTELLIGENCE CONTEXT",
    tone: "personal",
    entries: [
      ["personal-intelligence.ts", "PERSONAL_INTELLIGENCE_CONTEXT"],
      ["personal-intelligence.ts", "PERSONAL_INTELLIGENCE_VOICE_CONTEXT"],
      ["agent-home.ts", "PERSONAL_STANDING_CONTEXT"],
    ],
  },
  {
    id: "supporting",
    label: "OTHER ACTIVE MODEL PROMPTS AND AGENT DEFAULTS",
    tone: "supporting",
    entries: [
      ["agent-home.ts", "DEFAULT_STYLE_CONTEXT"],
      ["agent-home.ts", "DEFAULT_MEMORY_CONTEXT_TEMPLATE"],
      ["compaction.ts", "COMPACTION_SUMMARY_SYSTEM_PROMPT"],
      ["setup-assist.ts", "SETUP_ASSIST_SYSTEM_PROMPT"],
    ],
  },
];

export function createWorkspaceRegistry(manualRoot = process.env.GSV_MANUAL_ROOT) {
  return new Map([
    ["prompts", {
      id: "prompts",
      label: "Prompt Sources",
      root: resolve(REPO_ROOT, "workers/gateway/src/prompts"),
      extensions: new Set([".ts"]),
    }],
    ["manual", {
      id: "manual",
      label: "GSV Manual",
      root: resolve(manualRoot || resolve(REPO_ROOT, "../gsv-manual")),
      extensions: new Set([".md", ".json"]),
    }],
  ]);
}

export function resolveWorkspacePath(workspace, requestedPath) {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new HttpError(400, "A file path is required.");
  }
  const normalized = requestedPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const absolutePath = resolve(workspace.root, normalized);
  const relativePath = relative(workspace.root, absolutePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new HttpError(403, "The file is outside the selected source workspace.");
  }
  if (!workspace.extensions.has(extname(absolutePath))) {
    throw new HttpError(415, "That file type is not editable in this source workspace.");
  }
  return { absolutePath, relativePath: relativePath.replaceAll(sep, "/") };
}

export async function listWorkspaceFiles(workspace) {
  const files = [];
  await walk(workspace.root, "", workspace.extensions, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function loadPromptGroups(promptRoot) {
  const modules = new Map();
  const loadExport = async (path, exportName) => {
    let loaded = modules.get(path);
    if (!loaded) {
      const absolutePath = resolve(promptRoot, path);
      const metadata = await stat(absolutePath);
      loaded = await import(`${pathToFileURL(absolutePath).href}?mtime=${metadata.mtimeMs}`);
      modules.set(path, loaded);
    }
    return promptBlock(path, exportName, loaded[exportName]);
  };

  const groups = [];
  for (const group of PROMPT_GROUPS) {
    const blocks = [];
    for (const [path, exportName] of group.entries) {
      blocks.push(await loadExport(path, exportName));
    }
    groups.push({ id: group.id, label: group.label, tone: group.tone, blocks });
  }

  const blocks = groups.flatMap((group) => group.blocks);
  const bytes = blocks.reduce((total, block) => total + block.bytes, 0);
  return {
    note: "Evaluated repository exports, not one live Process prompt. Runtime identity, installed skills, targets, and user-edited context.d files are intentionally absent.",
    groups,
    blocks,
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
  };
}

export function createSourceReviewServer(options = {}) {
  const workspaces = options.workspaces ?? createWorkspaceRegistry(options.manualRoot);
  const initialWorkspace = normalizeWorkspaceId(options.initialWorkspace ?? "prompts", workspaces);
  return createServer(async (request, response) => {
    try {
      setSecurityHeaders(response);
      const url = new URL(request.url ?? "/", "http://source-review.local");
      if (request.method === "GET" && url.pathname === "/") {
        return sendFile(response, resolve(TOOL_ROOT, "index.html"), "text/html; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        return sendFile(response, resolve(TOOL_ROOT, "app.js"), "text/javascript; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/styles.css") {
        return sendFile(response, resolve(TOOL_ROOT, "styles.css"), "text/css; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        const available = [];
        for (const workspace of workspaces.values()) {
          if (await directoryExists(workspace.root)) {
            available.push({ id: workspace.id, label: workspace.label });
          }
        }
        return sendJson(response, 200, {
          initialWorkspace: available.some((item) => item.id === initialWorkspace)
            ? initialWorkspace
            : available[0]?.id,
          workspaces: available,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/files") {
        const workspace = requireWorkspace(url.searchParams.get("workspace"), workspaces);
        return sendJson(response, 200, {
          root: workspace.root,
          files: await listWorkspaceFiles(workspace),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/file") {
        const workspace = requireWorkspace(url.searchParams.get("workspace"), workspaces);
        const file = resolveWorkspacePath(workspace, url.searchParams.get("path"));
        const content = await readFile(file.absolutePath, "utf8");
        return sendJson(response, 200, { path: file.relativePath, content, hash: hashText(content) });
      }
      if (request.method === "PUT" && url.pathname === "/api/file") {
        assertSameOrigin(request);
        const body = await readJsonBody(request);
        if (!validateFileWrite(body)) throw invalidJsonBody(validateFileWrite.errors);
        const workspace = requireWorkspace(body.workspace, workspaces);
        const file = resolveWorkspacePath(workspace, body.path);
        const current = await readFile(file.absolutePath, "utf8");
        if (hashText(current) !== body.expectedHash) {
          throw new HttpError(409, "The file changed on disk. Refresh before overwriting it.");
        }
        await writeFile(file.absolutePath, body.content, "utf8");
        return sendJson(response, 200, { ok: true, hash: hashText(body.content) });
      }
      if (request.method === "GET" && url.pathname === "/api/diff") {
        const workspace = requireWorkspace(url.searchParams.get("workspace"), workspaces);
        const file = resolveWorkspacePath(workspace, url.searchParams.get("path"));
        const { stdout } = await execFileAsync(
          "git",
          ["diff", "--no-ext-diff", "--", file.relativePath],
          { cwd: workspace.root, maxBuffer: MAX_DIFF_BYTES },
        );
        return sendJson(response, 200, { diff: stdout });
      }
      if (request.method === "GET" && url.pathname === "/api/prompt-blocks") {
        const workspace = requireWorkspace("prompts", workspaces);
        return sendJson(response, 200, await loadPromptGroups(workspace.root));
      }
      if (request.method === "POST" && url.pathname === "/api/render-markdown") {
        assertSameOrigin(request);
        const body = await readJsonBody(request);
        if (!validateMarkdownRender(body)) throw invalidJsonBody(validateMarkdownRender.errors);
        const parseMarkdown = await markdownParser();
        return sendJson(response, 200, { html: await parseMarkdown(body.content) });
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, status, { error: message });
    }
  });
}

async function walk(root, prefix, extensions, output) {
  const directory = resolve(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, path, extensions, output);
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      const metadata = await stat(resolve(root, path));
      output.push({ path, bytes: metadata.size, modifiedAt: metadata.mtimeMs });
    }
  }
}

function promptBlock(path, exportName, text) {
  const bytes = TEXT_ENCODER.encode(text).length;
  return {
    path,
    exportName,
    text,
    bytes,
    characters: [...text].length,
    estimatedTokens: Math.ceil(bytes / 4),
  };
}

function requireWorkspace(id, workspaces) {
  if (!id) throw new HttpError(400, "workspace is required.");
  const workspace = workspaces.get(id);
  if (!workspace) throw new HttpError(404, `Unknown source workspace: ${id}`);
  return workspace;
}

function invalidJsonBody(errors) {
  const detail = errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  return new HttpError(400, detail ? `Invalid request body: ${detail}` : "Invalid request body.");
}

function normalizeWorkspaceId(id, workspaces) {
  return workspaces.has(id) ? id : "prompts";
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && host && new URL(origin).host !== host) {
    throw new HttpError(403, "Cross-origin writes are not allowed.");
  }
}

function setSecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

async function sendFile(response, path, contentType) {
  response.writeHead(200, { "content-type": contentType });
  response.end(await readFile(path));
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

let cachedMarkdownParser;
async function markdownParser() {
  if (!cachedMarkdownParser) {
    const requireFromWeb = createRequire(resolve(REPO_ROOT, "web/package.json"));
    const markedPath = requireFromWeb.resolve("marked");
    cachedMarkdownParser = import(pathToFileURL(markedPath).href).then(({ parse }) => {
      return (source) => parse(source, { async: false, breaks: true, gfm: true });
    });
  }
  return cachedMarkdownParser;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  const initialWorkspace = process.argv[2] ?? "prompts";
  const port = Number.parseInt(process.env.GSV_REVIEW_PORT ?? "4178", 10);
  const server = createSourceReviewServer({ initialWorkspace });
  server.listen(port, "127.0.0.1", () => {
    console.log(`GSV source review: http://127.0.0.1:${port}`);
    console.log(`Prompt sources: ${resolve(REPO_ROOT, "workers/gateway/src/prompts")}`);
    console.log(`Manual sources: ${resolve(process.env.GSV_MANUAL_ROOT || resolve(REPO_ROOT, "../gsv-manual"))}`);
  });
}
