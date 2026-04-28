import type { RipgitRepoRef } from "./client";

export function homeKnowledgeRepoRef(
  ownerUsername: string,
): RipgitRepoRef {
  return {
    owner: ownerUsername,
    repo: "home",
  };
}

export function workspaceRepoRef(
  workspaceId: string,
  ownerUsername: string,
): RipgitRepoRef {
  return {
    owner: ownerUsername,
    repo: workspaceId,
  };
}
