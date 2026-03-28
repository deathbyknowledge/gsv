import type { RipgitRepoRef } from "./client";

export function workspaceRepoRef(
  workspaceId: string,
  ownerUid: number,
): RipgitRepoRef {
  return {
    owner: `uid-${ownerUid}`,
    repo: workspaceId,
  };
}

export function homeKnowledgeRepoRef(ownerUid: number): RipgitRepoRef {
  return {
    owner: `uid-${ownerUid}`,
    repo: "home",
  };
}
