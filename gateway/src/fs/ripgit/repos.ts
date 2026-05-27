import type { RipgitRepoRef } from "./client";

export function homeKnowledgeRepoRef(
  ownerUsername: string,
): RipgitRepoRef {
  return {
    owner: ownerUsername,
    repo: "home",
  };
}
