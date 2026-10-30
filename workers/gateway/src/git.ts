import { parseRipgitFailure, ripgitFailureReference } from "./fs/ripgit/client";
import { removeUntrustedRipgitInstallationHeader } from "./installation/ripgit";

type BasicAuth = {
  username: string;
  credential: string;
};

// The public `/git/` proxy is the only internet-reachable door to ripgit, so it
// is the single boundary that decides what an external caller may do. Access is
// an explicit allowlist, never a denylist:
// - `public-read`: operations an unauthenticated caller may run against a repo
//   marked public (git upload-pack, and ripgit's GET/HEAD read APIs).
// - `write`: git push (receive-pack), which requires repo write authorization.
// - `refuse`: everything else, including ripgit's internal `hyperspace/*` and
//   `admin/*` APIs and every unknown method/path, none of which has a
//   legitimate external caller through `/git/` (the Kernel's own ripgit client
//   uses the private service binding directly).
export type GitProxyAccess = "public-read" | "write" | "refuse";

type GitPathMatch = {
  owner: string;
  repo: string;
  suffix: string;
  access: GitProxyAccess;
};

// First path segment of ripgit's read APIs. Each is served only for GET/HEAD and
// returns repository content without mutating it.
const GIT_READ_API_ACTIONS = new Set([
  "refs",
  "file",
  "search",
  "stats",
  "log",
  "diff",
  "compare",
  "commit",
  "tree",
  "blob",
]);

function classifyGitProxyAccess(
  method: string,
  suffix: string,
  service: string | null,
): GitProxyAccess {
  const isRead = method === "GET" || method === "HEAD";

  // ripgit's `/hyperspace/*` API is internal to the Kernel and never exposed.
  if (suffix === "hyperspace" || suffix.startsWith("hyperspace/")) {
    return "refuse";
  }

  // Git smart-HTTP ref advertisement selects the service through the query.
  if (suffix === "info/refs") {
    if (isRead && service === "git-upload-pack") return "public-read";
    if (service === "git-receive-pack") return "write";
    return "refuse";
  }

  // Git smart-HTTP data phase.
  if (suffix === "git-upload-pack" && method === "POST") return "public-read";
  if (suffix === "git-receive-pack" && method === "POST") return "write";

  // ripgit read APIs are public (GET/HEAD) for repos marked public.
  const action = suffix.split("/", 1)[0];
  if (isRead && GIT_READ_API_ACTIONS.has(action)) return "public-read";

  return "refuse";
}

export function matchGitPath(request: Request): GitPathMatch | null {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "git") {
    return null;
  }

  const owner = parts[1]?.trim();
  const repoPart = parts[2]?.trim();
  if (!owner || !repoPart) {
    return null;
  }

  const repo = repoPart.endsWith(".git") ? repoPart.slice(0, -4) : repoPart;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return null;
  }

  const suffix = parts.slice(3).join("/");
  const service = url.searchParams.get("service");
  return {
    owner,
    repo,
    suffix,
    access: classifyGitProxyAccess(request.method, suffix, service),
  };
}

export function getBasicAuth(request: Request): BasicAuth | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(header.slice("Basic ".length).trim());
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const username = decoded.slice(0, separator).trim();
    const credential = decoded.slice(separator + 1);
    if (!username || !credential) {
      return null;
    }
    return { username, credential };
  } catch {
    return null;
  }
}
export async function buildGitProxyRequest(
  request: Request,
  gitMatch: GitPathMatch,
  username: string | null,
): Promise<Request> {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(
    `https://ripgit/${encodeURIComponent(gitMatch.owner)}/${encodeURIComponent(gitMatch.repo)}/${gitMatch.suffix}`,
  );
  targetUrl.search = sourceUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  removeUntrustedRipgitInstallationHeader(headers);
  if (username) {
    headers.set("x-ripgit-actor-name", username);
  } else {
    headers.delete("x-ripgit-actor-name");
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  return new Request(targetUrl.toString(), init);
}

/** An outside caller learns that the request failed and the reference an operator can trace, never the cause. */
export async function publicGitResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const failure = parseRipgitFailure(await response.text().catch(() => ""));
  return new Response(failure ? `Repository request failed (${ripgitFailureReference(failure)})` : "Repository request failed", {
    status: response.status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
