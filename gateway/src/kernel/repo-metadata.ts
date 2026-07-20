import type { ConfigStore } from "./config";

export const REPO_METADATA_FIELDS = [
  "created_at",
  "updated_at",
  "description",
  "visibility",
] as const;

export type RepoMetadataField = typeof REPO_METADATA_FIELDS[number];

type RepoMetadataRef = {
  owner: string;
  repo: string;
};

export type RepoMetadataMutation =
  | {
      kind: "register";
      call: "repo.create" | "repo.apply" | "repo.import";
      repo: RepoMetadataRef;
      description?: string;
    }
  | {
      kind: "delete";
      call: "repo.delete";
      repo: RepoMetadataRef;
    }
  | {
      kind: "visibility";
      call: "repo.visibility.set";
      repo: RepoMetadataRef;
      public: boolean;
    };

export type RepoMetadataMutationResult = {
  changed: boolean;
};

type RepoMetadataConfig = Pick<ConfigStore, "get" | "set" | "delete">;

const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const REPO_SEGMENT_MAX_CHARACTERS = 128;

export function normalizeRepoMetadataMutation(input: unknown): RepoMetadataMutation {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid repository metadata mutation");
  }
  const value = input as Partial<RepoMetadataMutation> & Record<string, unknown>;
  const repo = normalizeRepoMetadataRef(value.repo);

  if (
    value.kind === "register"
    && (value.call === "repo.create" || value.call === "repo.apply" || value.call === "repo.import")
  ) {
    if (value.description !== undefined && typeof value.description !== "string") {
      throw new Error("Invalid repository description");
    }
    const description = typeof value.description === "string" ? value.description.trim() : "";
    return {
      kind: "register",
      call: value.call,
      repo,
      ...(description ? { description } : {}),
    };
  }
  if (value.kind === "delete" && value.call === "repo.delete") {
    return { kind: "delete", call: value.call, repo };
  }
  if (
    value.kind === "visibility"
    && value.call === "repo.visibility.set"
    && typeof value.public === "boolean"
  ) {
    return { kind: "visibility", call: value.call, repo, public: value.public };
  }
  throw new Error("Invalid repository metadata mutation");
}

export function applyRepoMetadataMutation(
  config: RepoMetadataConfig,
  input: RepoMetadataMutation,
  now: number = Date.now(),
): RepoMetadataMutationResult {
  const mutation = normalizeRepoMetadataMutation(input);
  if (mutation.kind === "register") {
    let changed = false;
    const createdKey = repoMetadataConfigKey(mutation.repo, "created_at");
    const updatedKey = repoMetadataConfigKey(mutation.repo, "updated_at");
    const previousUpdated = parseSafeTimestamp(config.get(updatedKey));
    const timestamp = String(Math.max(Math.trunc(now), (previousUpdated ?? 0) + 1));
    if (config.get(createdKey) === null) {
      config.set(createdKey, timestamp);
      changed = true;
    }
    if (config.get(updatedKey) !== timestamp) {
      config.set(updatedKey, timestamp);
      changed = true;
    }
    if (mutation.description) {
      const descriptionKey = repoMetadataConfigKey(mutation.repo, "description");
      if (config.get(descriptionKey) !== mutation.description) {
        config.set(descriptionKey, mutation.description);
        changed = true;
      }
    }
    return { changed };
  }

  if (mutation.kind === "delete") {
    let changed = false;
    for (const field of REPO_METADATA_FIELDS) {
      changed = config.delete(repoMetadataConfigKey(mutation.repo, field)) || changed;
    }
    return { changed };
  }

  const key = repoMetadataConfigKey(mutation.repo, "visibility");
  const wasPublic = config.get(key) === "public";
  if (mutation.public) {
    config.set(key, "public");
  } else {
    config.delete(key);
  }
  return { changed: wasPublic !== mutation.public };
}

export function repoMetadataConfigKey(
  repo: RepoMetadataRef,
  field: RepoMetadataField,
): string {
  const normalized = normalizeRepoMetadataRef(repo);
  if (!REPO_METADATA_FIELDS.includes(field)) {
    throw new Error(`Invalid repository metadata field: ${field}`);
  }
  return `repos/${normalized.owner}/${normalized.repo}/${field}`;
}

export function parseRepoMetadataConfigKey(
  key: string,
): (RepoMetadataRef & { field: RepoMetadataField }) | null {
  const parts = key.split("/");
  if (parts.length !== 4 || parts[0] !== "repos") {
    return null;
  }
  const field = parts[3] as RepoMetadataField;
  if (!REPO_METADATA_FIELDS.includes(field)) {
    return null;
  }
  try {
    return { ...normalizeRepoMetadataRef({ owner: parts[1], repo: parts[2] }), field };
  } catch {
    return null;
  }
}

export function selectRepoMetadataProjection(
  entries: Array<{ key: string; value: string }>,
  readableOwners: ReadonlySet<string>,
  includeAll: boolean,
): Array<{ key: string; value: string }> {
  const normalized = entries.flatMap((entry) => {
    const parsed = parseRepoMetadataConfigKey(entry.key);
    return parsed ? [{ entry, parsed }] : [];
  });
  const publicRepos = new Set(
    normalized
      .filter(({ entry, parsed }) => parsed.field === "visibility" && entry.value === "public")
      .map(({ parsed }) => `${parsed.owner}/${parsed.repo}`),
  );
  return normalized
    .filter(({ parsed }) => (
      includeAll
      || readableOwners.has(parsed.owner)
      || publicRepos.has(`${parsed.owner}/${parsed.repo}`)
    ))
    .map(({ entry }) => entry);
}

function normalizeRepoMetadataRef(value: unknown): RepoMetadataRef {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid repository metadata target");
  }
  const repo = value as Partial<RepoMetadataRef>;
  return {
    owner: normalizeRepoSegment(repo.owner, "owner"),
    repo: normalizeRepoSegment(repo.repo, "name"),
  };
}

function normalizeRepoSegment(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > REPO_SEGMENT_MAX_CHARACTERS
    || value.trim() !== value
    || value === "."
    || value === ".."
    || !REPO_SEGMENT_RE.test(value)
  ) {
    throw new Error(`Invalid repository ${label}`);
  }
  return value;
}

function parseSafeTimestamp(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
