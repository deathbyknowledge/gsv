import * as z from "zod/mini";

type RepoVisibilityConfig = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): boolean;
};
type RepoSlug = { owner: string; repo: string };
const repoSlugObjectSchema = z.object({ owner: z.string(), repo: z.string() });

export type RepoVisibility = "private" | "public";

export function repoVisibilityConfigKey(repo: string | RepoSlug): string {
  const object = repoSlugObjectSchema.safeParse(repo);
  const parsed = object.success
    ? {
        owner: normalizeRepoSegment(object.data.owner, "owner"),
        repo: normalizeRepoSegment(object.data.repo, "repo"),
      }
    : parseRepoSlug(z.string().parse(repo));
  return `repos/${parsed.owner}/${parsed.repo}/visibility`;
}

export function repoVisibility(
  repo: string | { owner: string; repo: string },
  config: Pick<RepoVisibilityConfig, "get">,
): RepoVisibility {
  return config.get(repoVisibilityConfigKey(repo)) === "public" ? "public" : "private";
}

export function isRepoPublic(
  repo: string | { owner: string; repo: string },
  config: Pick<RepoVisibilityConfig, "get">,
): boolean {
  return repoVisibility(repo, config) === "public";
}

export function setRepoVisibility(
  repo: string | { owner: string; repo: string },
  visibility: RepoVisibility,
  config: RepoVisibilityConfig,
): void {
  const key = repoVisibilityConfigKey(repo);
  if (visibility === "public") {
    config.set(key, "public");
    return;
  }
  config.delete(key);
}

function parseRepoSlug(raw: string): RepoSlug {
  const [owner, repo, ...rest] = raw.split("/");
  if (rest.length > 0) {
    throw new Error(`Invalid repo slug: ${raw}`);
  }
  return {
    owner: normalizeRepoSegment(owner, "owner"),
    repo: normalizeRepoSegment(repo, "repo"),
  };
}

function normalizeRepoSegment(value: string | undefined, label: string): string {
  const normalized = (value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid repo ${label}: ${value ?? ""}`);
  }
  return normalized;
}
