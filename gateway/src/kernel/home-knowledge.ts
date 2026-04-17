import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { homeKnowledgeRepoRef } from "../fs/ripgit/repos";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";

export async function ensureHomeStorageLayout(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
): Promise<void> {
  await ensureHomeDir(env.STORAGE, identity.home, identity.uid, identity.gid);

  if (!env.RIPGIT) {
    return;
  }

  const client = new RipgitClient(env.RIPGIT);
  const repo = homeKnowledgeRepoRef(identity.uid);
  const [
    constitution,
    contextDir,
    knowledgeDir,
    inboxDir,
  ] = await Promise.all([
    client.readPath(repo, "CONSTITUTION.md"),
    client.readPath(repo, "context.d"),
    client.readPath(repo, "knowledge"),
    client.readPath(repo, "knowledge/inbox"),
  ]);

  const ops: RipgitApplyOp[] = [];
  if (constitution.kind === "missing") {
    ops.push({
      type: "put" as const,
      path: "CONSTITUTION.md",
      contentBytes: [],
    });
  }
  if (contextDir.kind === "missing") {
    ops.push({
      type: "put" as const,
      path: "context.d/.dir",
      contentBytes: [],
    });
  }
  if (knowledgeDir.kind === "missing") {
    ops.push({
      type: "put" as const,
      path: "knowledge/.dir",
      contentBytes: [],
    });
  }
  if (inboxDir.kind === "missing") {
    ops.push({
      type: "put" as const,
      path: "knowledge/inbox/.dir",
      contentBytes: [],
    });
  }

  if (ops.length === 0) {
    return;
  }

  await client.apply(
    repo,
    identity.username,
    `${identity.username}@gsv.local`,
    "gsv: scaffold home knowledge",
    ops,
  );
}

async function ensureHomeDir(
  bucket: R2Bucket,
  home: string,
  uid: number,
  gid: number,
): Promise<void> {
  const normalized = home.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) {
    return;
  }

  const marker = `${normalized}/.dir`;
  const existing = await bucket.head(marker);
  if (existing) {
    return;
  }

  await bucket.put(marker, new ArrayBuffer(0), {
    customMetadata: {
      uid: String(uid),
      gid: String(gid),
      mode: "750",
      dirmarker: "1",
    },
  });
}
