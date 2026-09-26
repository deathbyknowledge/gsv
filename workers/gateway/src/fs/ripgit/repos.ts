import type { RipgitRepoRef } from "./client";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

/** Renaming a login or changing a home path must not relocate repository data. */
export function accountRepoOwner(account: Pick<ProcessIdentity, "username" | "repoOwner">): string {
  return account.repoOwner ?? account.username;
}

export function accountHomeRepoRef(
  account: Pick<ProcessIdentity, "username" | "repoOwner">,
): RipgitRepoRef {
  return {
    owner: accountRepoOwner(account),
    repo: "home",
  };
}
