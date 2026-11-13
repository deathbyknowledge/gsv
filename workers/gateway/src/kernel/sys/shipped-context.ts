import type { AiRoleContext, ContextFile, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RipgitApplyOp, RipgitClient, RipgitRepoRef } from "../../fs";
import { reconcileHomeOnce } from "../account-home";
import { crewAccountKey } from "../agents";
import type { KernelContext } from "../context";
import { SHIPPED_CONTEXT_SHA256S } from "./shipped-context-revisions";

const SHIPPED_REVISIONS = new Map<string, readonly string[]>(Object.entries(SHIPPED_CONTEXT_SHA256S));
const CREW_PLACEHOLDER = "{{crew.username}}";

/**
 * The read-only standing context a Ship or its Crew runs with, from
 * `config/ai/{ship,crew}/context.d`. A Ship's context names its Crew account;
 * a line that would name one before the Crew exists is left out.
 */
export function shippedRoleContext(
  ctx: Pick<KernelContext, "auth" | "config">,
  account: ProcessIdentity,
  ownerUid: number,
): AiRoleContext | undefined {
  const crewUid = ctx.config.get(crewAccountKey(ownerUid));
  if (ctx.auth.isPersonalAgentUid(account.uid)) {
    const crew = crewUid === null ? undefined : ctx.auth.getPasswdByUid(Number(crewUid))?.username;
    const files = roleFiles(ctx, "ship")
      .filter(({ text }) => crew !== undefined || !text.includes(CREW_PLACEHOLDER))
      .map(({ name, text }) => ({ name, text: crew === undefined ? text : text.replaceAll(CREW_PLACEHOLDER, () => crew) }));
    return { role: "ship", files };
  }
  if (crewUid !== null && Number(crewUid) === account.uid) return { role: "crew", files: roleFiles(ctx, "crew") };
  return undefined;
}

function roleFiles(ctx: Pick<KernelContext, "config">, role: AiRoleContext["role"]): ContextFile[] {
  const prefix = `config/ai/${role}/context.d/`;
  return ctx.config.list(prefix.slice(0, -1))
    .map(({ key, value }) => ({ name: key.slice(prefix.length), text: value }))
    .filter((file) => file.name.endsWith(".md") && file.text.trim().length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Ship and Crew homes used to receive copies of their role's context; the
 * Kernel now serves it. Once per account and Kernel lifetime, a copy that
 * matches a shipped revision is deleted, and any other is moved to
 * `context.d/retired/`, where it stays readable but no longer loads.
 */
export function retireSeededRoleContext(
  ctx: Pick<KernelContext, "env" | "auth">,
  identity: ProcessIdentity,
  role: AiRoleContext,
): Promise<void> {
  return reconcileHomeOnce(ctx, identity, "gsv: retire copied role context", async (client, repo) => {
    const ops = await seededRoleContextCleanupOps(client, repo, role);
    const kept = ops.filter((op) => op.type === "move").length;
    if (kept > 0) console.warn(`[Prompt] moved ${kept} edited ${role.role} context copies to context.d/retired`);
    return ops;
  });
}

export async function seededRoleContextCleanupOps(
  client: Pick<RipgitClient, "readPath">,
  repo: RipgitRepoRef,
  role: AiRoleContext,
): Promise<RipgitApplyOp[]> {
  const [root, retired] = await Promise.all([
    client.readPath(repo, "context.d"),
    client.readPath(repo, "context.d/retired"),
  ]);
  if (root.kind !== "tree") return [];
  const shipped = new Map(role.files.map((file) => [file.name, file.text]));
  // Revisions are listed for every name a role ever shipped, including ones it no longer has.
  const names = new Set([
    ...shipped.keys(),
    ...[...SHIPPED_REVISIONS.keys()].filter((key) => key.startsWith(`${role.role}/`)).map((key) => key.slice(role.role.length + 1)),
  ]);
  const taken = new Set(retired.kind === "tree" ? retired.entries.map((entry) => entry.name) : []);
  const copies = root.entries.filter((entry) => entry.type === "blob" && names.has(entry.name)).map((entry) => entry.name).sort();
  const ops: RipgitApplyOp[] = [];
  for (const name of copies) {
    const copy = await client.readPath(repo, `context.d/${name}`);
    if (copy.kind !== "file") continue;
    const hash = await sha256Hex(copy.bytes);
    const current = shipped.get(name);
    if (SHIPPED_REVISIONS.get(`${role.role}/${name}`)?.includes(hash)
      || (current !== undefined && hash === await sha256Hex(new TextEncoder().encode(current)))) {
      ops.push({ type: "delete", path: `context.d/${name}` });
      continue;
    }
    const kept = retiredName(name, taken);
    taken.add(kept);
    ops.push({ type: "move", from: `context.d/${name}`, to: `context.d/retired/${kept}` });
  }
  return ops;
}

function retiredName(name: string, taken: ReadonlySet<string>): string {
  const stem = name.replace(/\.md$/, "");
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? name : `${stem}-${suffix}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
