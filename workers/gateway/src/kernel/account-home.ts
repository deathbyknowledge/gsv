import { RipgitClient, RipgitConflictError, type RipgitApplyOp, type RipgitRepoRef } from "../fs/ripgit/client";
import { accountHomeRepoRef } from "../fs/ripgit/repos";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import {
  DEFAULT_MEMORY_CONTEXT_TEMPLATE,
  RETIRED_AGENT_VOICE_CONTEXT,
  RETIRED_BOOT_CONTEXT_TEMPLATE,
  RETIRED_STYLE_CONTEXT,
  RETIRED_MEMORY_CONTEXT_TEMPLATE,
} from "../prompts/agent-home";
import {
  PERSONAL_INTELLIGENCE_CONTEXT,
  PERSONAL_INTELLIGENCE_VOICE_CONTEXT,
  RETIRED_PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT,
} from "../prompts/personal-intelligence";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Seed missing defaults against a fixed revision; a concurrent owner edit wins. */
export async function seedAccountHome(
  env: Pick<Env, "RIPGIT">,
  identity: ProcessIdentity,
  message: string,
  collect: (client: RipgitClient, snapshot: RipgitRepoRef) => Promise<RipgitApplyOp[]>,
): Promise<void> {
  if (!env.RIPGIT) return;
  const client = new RipgitClient(env.RIPGIT);
  const repo = accountHomeRepoRef(identity.username);
  for (let attempt = 0; ; attempt++) {
    const head = (await client.refs(repo)).heads.main
      ?? (await client.apply(repo, identity.username, `${identity.username}@gsv.local`,
        "gsv: initialize home", [], { allowEmpty: true })).head;
    if (!head) throw new Error("Home initialization did not produce a revision");
    const ops = await collect(client, { ...repo, branch: head });
    if (ops.length === 0) return;
    try {
      await client.apply(repo, identity.username, `${identity.username}@gsv.local`, message, ops, { expectedHead: head });
      return;
    } catch (error) {
      if (!(error instanceof RipgitConflictError) || attempt >= 2) throw error;
    }
  }
}

export async function ensureAccountHomeLayout(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  options: {
    seedPromptContext?: boolean;
    personalAgent?: boolean;
    cleanupGeneratedPromptContext?: boolean;
    beforeRetiringGeneratedBootContext?: () => void;
  } = {},
): Promise<void> {
  await ensureHomeDir(env.STORAGE, identity.home, identity.uid, identity.gid);
  await seedAccountHome(env, identity, "gsv: scaffold home layout", (client, snapshot) =>
    homeLayoutOps(client, snapshot, options));
}

async function homeLayoutOps(
  client: RipgitClient,
  repo: RipgitRepoRef,
  options: NonNullable<Parameters<typeof ensureAccountHomeLayout>[2]>,
): Promise<RipgitApplyOp[]> {
  const [
    contextDir,
    bootContext,
    roleContext,
    styleContext,
    voiceContext,
    commitmentsContext,
    memoryContext,
    skillsDir,
  ] = await Promise.all([
    client.readPath(repo, "context.d"),
    client.readPath(repo, "context.d/00-boot.md"),
    client.readPath(repo, "context.d/00-role.md"),
    client.readPath(repo, "context.d/00-style.md"),
    client.readPath(repo, "context.d/05-voice.md"),
    client.readPath(repo, "context.d/10-commitments.md"),
    client.readPath(repo, "context.d/15-memory.md"),
    client.readPath(repo, "skills.d"),
  ]);

  const ops: RipgitApplyOp[] = [];
  if (contextDir.kind === "missing") {
    ops.push({
      type: "put" as const,
      path: "context.d/.dir",
      contentBytes: [],
    });
  }
  if (options.seedPromptContext === true || options.cleanupGeneratedPromptContext === true) {
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/00-style.md",
      styleContext,
      RETIRED_AGENT_VOICE_CONTEXT,
      RETIRED_STYLE_CONTEXT,
    );
  }
  if (options.seedPromptContext === true) {
    if (options.personalAgent === true) {
      const retiringGeneratedBootContext = maybeDeleteGeneratedTextFile(
        ops,
        "context.d/00-boot.md",
        bootContext,
        RETIRED_BOOT_CONTEXT_TEMPLATE,
      );
      if (retiringGeneratedBootContext) {
        options.beforeRetiringGeneratedBootContext?.();
      }
      maybePutTextFile(
        ops,
        "context.d/00-role.md",
        roleContext,
        PERSONAL_INTELLIGENCE_CONTEXT,
      );
      maybePutTextFile(
        ops,
        "context.d/05-voice.md",
        voiceContext,
        PERSONAL_INTELLIGENCE_VOICE_CONTEXT,
      );
      maybeDeleteGeneratedTextFile(
        ops,
        "context.d/10-commitments.md",
        commitmentsContext,
        RETIRED_PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT,
      );
      maybeDeleteGeneratedTextFile(
        ops,
        "context.d/15-memory.md",
        memoryContext,
        DEFAULT_MEMORY_CONTEXT_TEMPLATE,
        RETIRED_MEMORY_CONTEXT_TEMPLATE,
      );
    } else {
      maybePutTextFile(
        ops,
        "context.d/15-memory.md",
        memoryContext,
        DEFAULT_MEMORY_CONTEXT_TEMPLATE,
      );
    }
  } else if (options.cleanupGeneratedPromptContext === true) {
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/00-boot.md",
      bootContext,
      RETIRED_BOOT_CONTEXT_TEMPLATE,
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/15-memory.md",
      memoryContext,
      DEFAULT_MEMORY_CONTEXT_TEMPLATE,
      RETIRED_MEMORY_CONTEXT_TEMPLATE,
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/10-commitments.md",
      commitmentsContext,
      RETIRED_PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT,
    );
  }
  if (skillsDir.kind === "missing") {
    ops.push({
      type: "put" as const,
      path: "skills.d/.dir",
      contentBytes: [],
    });
  }
  return ops;
}

function maybePutTextFile(
  ops: RipgitApplyOp[],
  path: string,
  existing: Awaited<ReturnType<RipgitClient["readPath"]>>,
  content: string,
): void {
  if (existing.kind !== "missing") {
    return;
  }
  ops.push({
    type: "put",
    path,
    contentBytes: Array.from(TEXT_ENCODER.encode(content)),
  });
}

function maybeDeleteGeneratedTextFile(
  ops: RipgitApplyOp[],
  path: string,
  existing: Awaited<ReturnType<RipgitClient["readPath"]>>,
  ...generatedContents: string[]
): boolean {
  if (existing.kind !== "file") {
    return false;
  }
  const text = TEXT_DECODER.decode(existing.bytes);
  if (!generatedContents.includes(text)) {
    return false;
  }
  ops.push({
    type: "delete",
    path,
  });
  return true;
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
