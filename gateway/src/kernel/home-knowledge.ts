import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { homeKnowledgeRepoRef } from "../fs/ripgit/repos";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  DEFAULT_BOOT_CONTEXT_TEMPLATE,
  DEFAULT_STYLE_CONTEXT,
  DEFAULT_USER_CONTEXT_TEMPLATE,
  LEGACY_DEFAULT_CONSTITUTION_CONTEXT,
} from "../prompts/agent-home";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function ensureHomeStorageLayout(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  options: {
    userContextUsername?: string;
    seedPromptContext?: boolean;
    seedBootContext?: boolean;
    cleanupGeneratedPromptContext?: boolean;
  } = {},
): Promise<void> {
  await ensureHomeDir(env.STORAGE, identity.home, identity.uid, identity.gid);

  if (!env.RIPGIT) {
    return;
  }

  const client = new RipgitClient(env.RIPGIT);
  const repo = homeKnowledgeRepoRef(identity.username);
  const [
    contextDir,
    bootContext,
    styleContext,
    constitutionContext,
    userContext,
    skillsDir,
    knowledgeDir,
    inboxDir,
  ] = await Promise.all([
    client.readPath(repo, "context.d"),
    client.readPath(repo, "context.d/00-boot.md"),
    client.readPath(repo, "context.d/00-style.md"),
    client.readPath(repo, "context.d/00-constitution.md"),
    client.readPath(repo, "context.d/10-user.md"),
    client.readPath(repo, "skills.d"),
    client.readPath(repo, "knowledge"),
    client.readPath(repo, "knowledge/inbox"),
  ]);

  const ops: RipgitApplyOp[] = [];
  const userContextUsername = options.userContextUsername ?? identity.username;
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
        renderBootContext(identity.home),
      );
    }
    maybePutTextFile(
      ops,
      "context.d/00-style.md",
      styleContext,
      DEFAULT_STYLE_CONTEXT,
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/00-constitution.md",
      constitutionContext,
      [LEGACY_DEFAULT_CONSTITUTION_CONTEXT],
    );
    maybePutOrReplaceGeneratedTextFile(
      ops,
      "context.d/10-user.md",
      userContext,
      renderUserContext(userContextUsername),
      userContextUsername !== identity.username ? renderUserContext(identity.username) : undefined,
    );
  } else if (options.cleanupGeneratedPromptContext === true) {
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/00-boot.md",
      bootContext,
      [renderBootContext(identity.home)],
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/00-style.md",
      styleContext,
      [DEFAULT_STYLE_CONTEXT],
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/00-constitution.md",
      constitutionContext,
      [LEGACY_DEFAULT_CONSTITUTION_CONTEXT],
    );
    maybeDeleteGeneratedTextFile(
      ops,
      "context.d/10-user.md",
      userContext,
      [renderUserContext(identity.username), renderUserContext(userContextUsername)],
    );
  }
  if (skillsDir.kind === "missing") {
    ops.push({
      type: "put" as const,
      path: "skills.d/.dir",
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

function maybePutOrReplaceGeneratedTextFile(
  ops: RipgitApplyOp[],
  path: string,
  existing: Awaited<ReturnType<RipgitClient["readPath"]>>,
  content: string,
  generatedPreviousContent?: string,
): void {
  if (existing.kind === "missing") {
    maybePutTextFile(ops, path, existing, content);
    return;
  }
  if (
    generatedPreviousContent &&
    existing.kind === "file" &&
    TEXT_DECODER.decode(existing.bytes) === generatedPreviousContent
  ) {
    ops.push({
      type: "put",
      path,
      contentBytes: Array.from(TEXT_ENCODER.encode(content)),
    });
  }
}

function maybeDeleteGeneratedTextFile(
  ops: RipgitApplyOp[],
  path: string,
  existing: Awaited<ReturnType<RipgitClient["readPath"]>>,
  generatedContents: string[],
): void {
  if (existing.kind !== "file") {
    return;
  }
  const text = TEXT_DECODER.decode(existing.bytes);
  if (!generatedContents.some((content) => content === text)) {
    return;
  }
  ops.push({
    type: "delete",
    path,
  });
}

function renderBootContext(home: string): string {
  return renderPromptTemplate(DEFAULT_BOOT_CONTEXT_TEMPLATE, {
    "program.home": home,
  });
}

function renderUserContext(username: string): string {
  return renderPromptTemplate(DEFAULT_USER_CONTEXT_TEMPLATE, {
    "user.username": username,
  });
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
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
