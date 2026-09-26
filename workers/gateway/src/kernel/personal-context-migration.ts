import { RipgitConflictError } from "../fs/ripgit/client";
import type { RipgitClient, RipgitRepoRef, RipgitApplyOp } from "../fs/ripgit/client";
import { ensureHomeRepoRevision } from "../fs/ripgit/repos";
import { LEGACY_PERSONAL_INTELLIGENCE_CONTEXT, LEGACY_PERSONAL_INTELLIGENCE_VOICE_CONTEXT } from "../prompts/legacy-personal-intelligence";
import { PERSONAL_INTELLIGENCE_CONTEXT, PERSONAL_INTELLIGENCE_VOICE_CONTEXT } from "../prompts/personal-intelligence";

export const PERSONAL_CONTEXT_MIGRATION_MARKER = ".gsv/ship-context-v1";

/** Move Ship policy out of shared context without overwriting an owner's edits. */
export async function migratePersonalContext(client: RipgitClient, repo: RipgitRepoRef, username: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await migrateHomeRevision(client, repo, username);
    } catch (error) {
      if (!(error instanceof RipgitConflictError) || attempt >= 2) throw error;
    }
  }
}

async function migrateHomeRevision(client: RipgitClient, repo: RipgitRepoRef, username: string): Promise<void> {
  const head = await ensureHomeRepoRevision(client, repo, username);
  const snapshot = { ...repo, branch: head };
  if ((await client.readPath(snapshot, PERSONAL_CONTEXT_MIGRATION_MARKER)).kind !== "missing") return;
  const seeds = [
    { name: "00-role.md", old: LEGACY_PERSONAL_INTELLIGENCE_CONTEXT, current: PERSONAL_INTELLIGENCE_CONTEXT },
    { name: "05-voice.md", old: LEGACY_PERSONAL_INTELLIGENCE_VOICE_CONTEXT, current: PERSONAL_INTELLIGENCE_VOICE_CONTEXT },
  ];
  const ops: RipgitApplyOp[] = [];
  for (const seed of seeds) {
    const from = `context.d/${seed.name}`;
    const file = await client.readPath(snapshot, from);
    if (file.kind !== "file") continue;
    const original = new TextDecoder().decode(file.bytes);
    const generated = original === seed.old;
    const bytes = generated ? new TextEncoder().encode(seed.current) : file.bytes;
    let to = `context.d/ship/${seed.name}`;
    const destination = await client.readPath(snapshot, to);
    if (destination.kind !== "missing" && !generated) {
      if (destination.kind !== "file" || new TextDecoder().decode(destination.bytes) !== original) {
        const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
        const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
        to = `context.d/ship/${seed.name.slice(0, -3)}.previous-${digest}.md`;
        const previous = await client.readPath(snapshot, to);
        if (previous.kind !== "missing" && (previous.kind !== "file" || new TextDecoder().decode(previous.bytes) !== original)) {
          throw new Error("Personal context migration destination is occupied");
        }
        if (previous.kind === "missing") ops.push({ type: "put", path: to, contentBytes: Array.from(bytes) });
      }
    } else if (destination.kind === "missing") {
      ops.push({ type: "put", path: to, contentBytes: Array.from(bytes) });
    }
    ops.push({ type: "delete", path: from });
  }
  ops.push({ type: "put", path: PERSONAL_CONTEXT_MIGRATION_MARKER, contentBytes: [] });
  await client.apply(repo, username, `${username}@gsv.local`, "gsv: scope Ship context", ops, { expectedHead: head });
}
