import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TOOL_ROOT, "../..");
const DEFAULT_PORT = 4179;
const DEFAULT_SOURCE_METADATA = Object.freeze({
  sourceBase: "https://github.com/deathbyknowledge/gsv",
  sha: "main",
});
const TRACKING_FORMAT = "%(upstream:remotename)%09%(upstream:remoteref)";
const SAFE_GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SAFE_GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const STATIC_ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/architecture.mjs", ["architecture.mjs", "text/javascript; charset=utf-8"]],
  ["/atlas-meta.mjs", ["atlas-meta.mjs", "text/javascript; charset=utf-8"]],
  ["/plain-language.mjs", ["plain-language.mjs", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

export function createArchitectureExplorerServer(options = {}) {
  const metadata = options.metadata
    ?? (options.revision
      ? async () => ({ ...DEFAULT_SOURCE_METADATA, sha: await options.revision() })
      : resolveGitHubSourceMetadata);
  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url ?? "/", "http://architecture.local");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 405, { error: "Method not allowed." }, request.method === "HEAD");
      }
      if (url.pathname === "/api/meta") {
        return sendJson(response, 200, await metadata(), request.method === "HEAD");
      }
      const asset = STATIC_ASSETS.get(url.pathname);
      if (!asset) {
        return sendJson(response, 404, { error: "Not found." }, request.method === "HEAD");
      }
      const [filename, contentType] = asset;
      const body = await readFile(resolve(TOOL_ROOT, filename));
      response.writeHead(200, {
        "content-type": contentType,
        "content-length": body.length,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message }, request.method === "HEAD");
    }
  });
}

export async function resolveGitHubSourceMetadata(git = runGit) {
  const branch = await tryGit(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch) {
    const tracking = await tryGit(git, [
      "for-each-ref",
      `--format=${TRACKING_FORMAT}`,
      `refs/heads/${branch}`,
    ]);
    const [remote, mergeRef] = tracking?.split("\t", 2) ?? [];
    const ref = sourceRefFromMergeRef(mergeRef);
    const sourceBase = await sourceBaseForRemote(git, remote);
    if (sourceBase && ref) {
      return { sourceBase, sha: ref };
    }
  }

  const remoteNames = (await tryGit(git, ["remote"]))?.split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter((remote) => /^[A-Za-z0-9._-]+$/.test(remote)) ?? [];
  const orderedRemotes = [
    ...remoteNames.filter((remote) => remote === "origin"),
    ...remoteNames.filter((remote) => remote !== "origin"),
  ];
  for (const remote of orderedRemotes) {
    const sourceBase = await sourceBaseForRemote(git, remote);
    if (!sourceBase) continue;
    const remoteHead = await tryGit(git, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    const prefix = `${remote}/`;
    const ref = remoteHead?.startsWith(prefix)
      ? validSourceRef(remoteHead.slice(prefix.length))
      : null;
    if (ref) {
      return { sourceBase, sha: ref };
    }
  }

  return { ...DEFAULT_SOURCE_METADATA };
}

async function sourceBaseForRemote(git, remote) {
  if (!remote || remote === "." || !/^[A-Za-z0-9._-]+$/.test(remote)) {
    return null;
  }
  const remoteUrl = await tryGit(git, ["remote", "get-url", remote]);
  return githubSourceBase(remoteUrl);
}

function sourceRefFromMergeRef(value) {
  const prefix = "refs/heads/";
  return value?.startsWith(prefix) ? validSourceRef(value.slice(prefix.length)) : null;
}

function validSourceRef(value) {
  if (
    !value
    || !SAFE_GIT_NAME.test(value)
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || value.endsWith("/")
    || value.endsWith(".")
  ) {
    return null;
  }
  return value;
}

function githubSourceBase(value) {
  if (!value) return null;
  let owner;
  let repository;
  const scp = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (scp) {
    [, owner, repository] = scp;
  } else {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (
      url.hostname.toLowerCase() !== "github.com"
      || !new Set(["https:", "http:", "ssh:", "git:"]).has(url.protocol)
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return null;
    [owner, repository] = segments;
  }
  repository = repository.replace(/\.git$/i, "");
  if (
    !SAFE_GITHUB_SEGMENT.test(owner)
    || !SAFE_GITHUB_SEGMENT.test(repository)
    || owner === "."
    || owner === ".."
    || repository === "."
    || repository === ".."
  ) {
    return null;
  }
  return `https://github.com/${owner}/${repository}`;
}

async function tryGit(git, args) {
  try {
    const output = await git(args);
    return output.trim() || null;
  } catch {
    return null;
  }
}

async function runGit(args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024,
  });
  return stdout.trim();
}

function setSecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response, status, value, headOnly = false) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  response.end(headOnly ? undefined : body);
}

function parsePort(value) {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("GSV_ARCHITECTURE_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parsePort(process.env.GSV_ARCHITECTURE_PORT);
  const server = createArchitectureExplorerServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`GSV architecture explorer: http://127.0.0.1:${port}`);
  });
}
