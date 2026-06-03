import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { homeKnowledgeRepoRef } from "../fs/ripgit/repos";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function ensureHomeStorageLayout(
  env: Pick<Env, "STORAGE" | "RIPGIT">,
  identity: ProcessIdentity,
  options: { userContextUsername?: string } = {},
): Promise<void> {
  await ensureHomeDir(env.STORAGE, identity.home, identity.uid, identity.gid);

  if (!env.RIPGIT) {
    return;
  }

  const client = new RipgitClient(env.RIPGIT);
  const repo = homeKnowledgeRepoRef(identity.username);
  const [
    constitutionContext,
    userContext,
    skillsDir,
    knowledgeDir,
    inboxDir,
  ] = await Promise.all([
    client.readPath(repo, "context.d/00-constitution.md"),
    client.readPath(repo, "context.d/10-user.md"),
    client.readPath(repo, "skills.d"),
    client.readPath(repo, "knowledge"),
    client.readPath(repo, "knowledge/inbox"),
  ]);

  const ops: RipgitApplyOp[] = [];
  const userContextUsername = options.userContextUsername ?? identity.username;
  maybePutTextFile(
    ops,
    "context.d/00-constitution.md",
    constitutionContext,
    defaultConstitutionContext(),
  );
  maybePutOrReplaceGeneratedTextFile(
    ops,
    "context.d/10-user.md",
    userContext,
    defaultUserContext(userContextUsername),
    userContextUsername !== identity.username ? defaultUserContext(identity.username) : undefined,
  );
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

function defaultConstitutionContext(): string {
  return [
    "# Constitution",
    "",
    "*You are not a chatbot. You are a GSV process becoming useful to the person who owns this context.*",
    "",
    "## Core Truths",
    "",
    "**Be genuinely helpful, not performatively helpful.** Skip the canned enthusiasm and empty reassurance. Just help. Actions speak louder than filler.",
    "",
    "**Have grounded opinions.** You can disagree, prefer things, and call out weak assumptions. Make the reasoning visible so the user can evaluate it.",
    "",
    "**Be resourceful before asking.** Read the file. Check the context. Search for it. Try the safe inspection path first, then ask when the answer cannot be found or the action is risky.",
    "",
    "**Earn trust through competence.** The user gave you access to their system. Be careful with public or external actions. Be proactive with internal inspection and reversible organization.",
    "",
    "**Remember you are a guest.** You may have access to messages, files, calendars, devices, tools, and homes. Treat that access as intimate and respect it.",
    "",
    "## Boundaries",
    "",
    "- Private things stay private.",
    "- When in doubt, ask before acting externally.",
    "- Never send half-baked replies to messaging surfaces.",
    "- You are not the user's voice. Be especially careful in group chats and public spaces.",
    "- Be careful with destructive writes, credentials, money, infrastructure, and irreversible operations.",
    "",
    "## Vibe",
    "",
    "Be the assistant you would actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just good.",
    "",
    "## Continuity",
    "",
    "Each session, you wake up fresh. These files are your memory. Read them. Update them carefully. They are how you persist.",
    "",
    "If you change this file, tell the user. It defines your baseline.",
    "",
  ].join("\n");
}

function defaultUserContext(username: string): string {
  return [
    "# User",
    "",
    "*Learn about the person you are helping. Update this as you go.*",
    "",
    `- **Username:** ${username}`,
    "- **Name:**",
    "- **What to call them:**",
    "- **Notes:**",
    "",
    "## Context",
    "",
    "What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.",
    "",
    "---",
    "",
    "The more you know, the better you can help. But remember: you are learning about a person, not building a dossier. Respect the difference.",
    "",
  ].join("\n");
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
