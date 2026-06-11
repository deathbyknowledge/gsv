import type { RipgitRepoRef } from "./client";

export function accountHomeRepoRef(
  ownerUsername: string,
): RipgitRepoRef {
  return {
    owner: ownerUsername,
    repo: "home",
  };
}
