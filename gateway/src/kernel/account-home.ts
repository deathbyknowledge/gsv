import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { accountHomeRepoRef } from "../fs/ripgit/repos";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import {
  DEFAULT_BOOT_CONTEXT_TEMPLATE,
  DEFAULT_MEMORY_CONTEXT_TEMPLATE,
  DEFAULT_STYLE_CONTEXT,
} from "../prompts/agent-home";
import {
  PERSONAL_INTELLIGENCE_CONTEXT,
  PERSONAL_INTELLIGENCE_VOICE_CONTEXT,
  RETIRED_PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT,
} from "../prompts/personal-intelligence";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function ensureAccountHomeLayout(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  options: {
    seedPromptContext?: boolean;
    personalAgent?: boolean;
    seedBootContext?: boolean;
    cleanupGeneratedPromptContext?: boolean;
  } = {},
): Promise<void> {
  await ensureHomeDir(env.STORAGE, identity.home, identity.uid, identity.gid);

  if (!env.RIPGIT) {
    return;
  }

  const client = new RipgitClient(env.RIPGIT);
  const repo = accountHomeRepoRef(identity.username);
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
  if (options.seedPromptContext === true) {
    if (options.seedBootContext === true) {
      maybePutTextFile(
        ops,
        "context.d/00-boot.md",
        bootContext,
        DEFAULT_BOOT_CONTEXT_TEMPLATE,
      );
    }
    if (options.personalAgent === true) {
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
        "context.d/00-style.md",
        styleContext,
        DEFAULT_STYLE_CONTEXT,
      );
      maybeDeleteGeneratedTextFile(
        ops,
        "context.d/15-memory.md",
        memoryContext,
        DEFAULT_MEMORY_CONTEXT_TEMPLATE,
      );
    } else {
      maybePutTextFile(
        ops,
        "context.d/00-style.md",
        styleContext,
        DEFAULT_STYLE_CONTEXT,
      );
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
      DEFAULT_BOOT_CONTEXT_TEMPLATE,
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/00-style.md",
      styleContext,
      DEFAULT_STYLE_CONTEXT,
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/15-memory.md",
      memoryContext,
      DEFAULT_MEMORY_CONTEXT_TEMPLATE,
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
  if (ops.length === 0) {
    return;
  }

  await client.apply(
    repo,
    identity.username,
    `${identity.username}@gsv.local`,
    "gsv: scaffold home layout",
    ops,
  );
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
  generatedContent: string,
): void {
  if (existing.kind !== "file") {
    return;
  }
  const text = TEXT_DECODER.decode(existing.bytes);
  if (text !== generatedContent) {
    return;
  }
  ops.push({
    type: "delete",
    path,
  });
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
