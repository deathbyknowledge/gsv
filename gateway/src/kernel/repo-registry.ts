import type { AuthStore } from "./auth-store";
import type { ConfigStore } from "./config";
import { repoVisibilityConfigKey } from "./repo-visibility";

export type RegisteredRepoRef = {
  owner: string;
  repo: string;
};

export function listInstallationRepos(
  config: ConfigStore,
  auth: AuthStore,
): RegisteredRepoRef[] {
  const repos = new Map<string, RegisteredRepoRef>();
  for (const entry of auth.getPasswdEntries()) {
    addRepo(repos, { owner: entry.username, repo: "home" });
  }
  for (const row of config.listExplicit("repos")) {
    const parsed = parseRegisteredRepoKey(row.key);
    if (parsed?.field === "created_at") {
      addRepo(repos, { owner: parsed.owner, repo: parsed.repo });
    }
  }
  return [...repos.values()].sort(compareRepos);
}

export function listRegisteredRepos(config: ConfigStore): RegisteredRepoRef[] {
  const repos: RegisteredRepoRef[] = [];
  for (const row of config.listExplicit("repos")) {
    const parsed = parseRegisteredRepoKey(row.key);
    if (parsed?.field === "created_at") {
      repos.push({ owner: parsed.owner, repo: parsed.repo });
    }
  }
  return repos.sort(compareRepos);
}

export function registerRepo(
  config: ConfigStore,
  repo: RegisteredRepoRef,
  description?: string,
): void {
  const now = String(Date.now());
  const createdKey = repoConfigKey(repo, "created_at");
  if (config.get(createdKey) === null) {
    config.set(createdKey, now);
  }
  config.set(repoConfigKey(repo, "updated_at"), now);
  if (typeof description === "string" && description.trim().length > 0) {
    config.set(repoConfigKey(repo, "description"), description.trim());
  }
}

export function unregisterRepo(
  config: ConfigStore,
  repo: RegisteredRepoRef,
): void {
  for (const field of ["created_at", "updated_at", "description"]) {
    config.delete(repoConfigKey(repo, field));
  }
  config.delete(repoVisibilityConfigKey(repo));
}

export function repoConfigKey(repo: RegisteredRepoRef, field: string): string {
  return `repos/${repo.owner}/${repo.repo}/${field}`;
}

export function parseRegisteredRepoKey(
  key: string,
): (RegisteredRepoRef & { field: string }) | null {
  const parts = key.split("/");
  if (parts.length !== 4 || parts[0] !== "repos") {
    return null;
  }
  if (!isRepoSegment(parts[1]) || !isRepoSegment(parts[2])) {
    return null;
  }
  return {
    owner: parts[1],
    repo: parts[2],
    field: parts[3],
  };
}

function addRepo(
  repos: Map<string, RegisteredRepoRef>,
  repo: RegisteredRepoRef,
): void {
  repos.set(repoSlug(repo), repo);
}

function repoSlug(repo: RegisteredRepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function compareRepos(left: RegisteredRepoRef, right: RegisteredRepoRef): number {
  return compareAscii(left.owner, right.owner) || compareAscii(left.repo, right.repo);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRepoSegment(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
}
