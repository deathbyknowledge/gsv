import type { RipgitClient, RipgitRepoRef } from "./client";
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

/** Establish a revision without touching files, then fence subsequent content writes. */
export async function ensureHomeRepoRevision(client: RipgitClient, repo: RipgitRepoRef, username: string): Promise<string> {
  const head = (await client.refs(repo)).heads[repo.branch ?? "main"];
  if (head) return head;
  const initialized = await client.apply(repo, username, `${username}@gsv.local`, "gsv: initialize home", [], { allowEmpty: true });
  if (!initialized.head) throw new Error("Home initialization did not produce a repository revision");
  return initialized.head;
}
