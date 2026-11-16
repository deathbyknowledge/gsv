import type { AiRoleContext, ContextFile, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { RipgitApplyOp, RipgitClient, RipgitRepoRef } from "../../fs";
import retiredContextInstructions from "../../prompts/tasks/retired-context.md";
import { reconcileHomeOnce } from "../account-home";
import { crewAccountKey } from "../agents";
import type { KernelContext } from "../context";
import { SHIPPED_CONTEXT_SHA256S } from "./shipped-context-revisions";

const SHIPPED_REVISIONS = new Map<string, readonly string[]>(Object.entries(SHIPPED_CONTEXT_SHA256S));
const CREW_PLACEHOLDER = "{{crew.username}}";

type ShippedRole = "ship" | "crew";

/**
 * The read-only standing context a Ship or its Crew runs with, from
 * `config/ai/{ship,crew}/context.d`, named after its role. A Ship's context
 * names its Crew account; a line that would name it before the Crew exists is
 * left out.
 */
export function shippedRoleContext(
  ctx: Pick<KernelContext, "auth" | "config">,
  account: ProcessIdentity,
  ownerUid: number,
): AiRoleContext | undefined {
  const crewUid = ctx.config.get(crewAccountKey(ownerUid));
  if (ctx.auth.isPersonalAgentUid(account.uid)) {
    const crew = crewUid === null ? undefined : ctx.auth.getPasswdByUid(Number(crewUid))?.username;
    const files = roleFiles(ctx, "ship").map(({ name, text }) => ({
      name,
      text: crew === undefined
        ? text.split("\n").filter((line) => !line.includes(CREW_PLACEHOLDER)).join("\n")
        : text.replaceAll(CREW_PLACEHOLDER, () => crew),
    }));
    return roleContext("ship", files);
  }
  if (crewUid !== null && Number(crewUid) === account.uid) return roleContext("crew", roleFiles(ctx, "crew"));
  return undefined;
}

function roleContext(role: ShippedRole, files: ContextFile[]): AiRoleContext {
  return { name: role, location: `/sys/config/ai/${role}/context.d`, files };
}

function roleFiles(ctx: Pick<KernelContext, "config">, role: ShippedRole): ContextFile[] {
  const prefix = `config/ai/${role}/context.d/`;
  return ctx.config.list(prefix.slice(0, -1))
    .map(({ key, value }) => ({ name: key.slice(prefix.length), text: value }))
    .filter((file) => file.name.endsWith(".md") && file.text.trim().length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Ship and Crew homes used to receive copies of their role's context under the
 * names in SHIPPED_CONTEXT_SHA256S; the Kernel now serves it. Once per account
 * and Kernel lifetime, a copy that matches a shipped revision is deleted, and
 * any other file under one of those names is moved to `context.d/retired/`,
 * where it stays readable but no longer loads. A retired copy may hold what the
 * owner asked for, so while any remain the Ship gets one responsibility to
 * carry that into the account's own context; the responsibility is the receipt.
 */
export async function retireSeededRoleContext(
  ctx: Pick<KernelContext, "env" | "auth" | "responsibilities" | "reconcileResponsibilityWake" | "defer">,
  identity: ProcessIdentity,
  role: AiRoleContext,
  ownerUid: number,
): Promise<void> {
  // Only the call whose cleanup ran sees the retired copies.
  let retired: string[] = [];
  await reconcileHomeOnce(ctx, identity, "gsv: retire copied role context", async (client, repo) => {
    const cleanup = await seededRoleContextCleanup(client, repo, role);
    const moved = cleanup.ops.filter((op) => op.type === "move").length;
    if (moved > 0) console.warn(`[Prompt] moved ${moved} edited ${role.name} context copies to context.d/retired`);
    retired = cleanup.retired.map((name) => `${identity.home}/context.d/retired/${name}`);
    return cleanup.ops;
  });
  const dedupeKey = `shipped-context.retired:${identity.uid}`;
  if (retired.length === 0 || ctx.responsibilities.getByDedupeKey(ownerUid, dedupeKey)) return;
  const source = { kind: "system", component: "shipped-context" } as const;
  ctx.responsibilities.create({
    ownerUid,
    title: "Carry over saved preferences",
    details: {
      instructions: retiredContextInstructions.trim(),
      home: identity.home,
      release: role.location,
      retired,
    },
    source,
    actor: source,
    assignee: { kind: "ship" },
    state: "open",
    priority: "low",
    dedupeKey,
    observedByShip: false,
    now: Date.now(),
  });
  ctx.defer(ctx.reconcileResponsibilityWake(ownerUid).catch((error) => {
    console.warn("[Prompt] failed to schedule the retired context responsibility:", exceptionDiagnostics(error));
  }));
}

/**
 * The cleanup for one home, and every retired copy it leaves there afterwards:
 * those it moves now and any an earlier cleanup moved.
 */
export async function seededRoleContextCleanup(
  client: Pick<RipgitClient, "readPath">,
  repo: RipgitRepoRef,
  role: AiRoleContext,
): Promise<{ ops: RipgitApplyOp[]; retired: string[] }> {
  const [root, retired] = await Promise.all([
    client.readPath(repo, "context.d"),
    client.readPath(repo, "context.d/retired"),
  ]);
  if (root.kind !== "tree") return { ops: [], retired: [] };
  // Only names that were once copied into homes; an account's own file never shares one.
  const names = new Set([...SHIPPED_REVISIONS.keys()]
    .filter((key) => key.startsWith(`${role.name}/`))
    .map((key) => key.slice(role.name.length + 1)));
  const taken = new Set(retired.kind === "tree" ? retired.entries.map((entry) => entry.name) : []);
  const kept = [...taken].filter((name) => names.has(name.replace(/-\d+\.md$/, ".md")));
  const copies = root.entries.filter((entry) => entry.type === "blob" && names.has(entry.name)).map((entry) => entry.name).sort();
  const ops: RipgitApplyOp[] = [];
  for (const name of copies) {
    const copy = await client.readPath(repo, `context.d/${name}`);
    if (copy.kind !== "file") continue;
    if (SHIPPED_REVISIONS.get(`${role.name}/${name}`)?.includes(await sha256Hex(copy.bytes))) {
      ops.push({ type: "delete", path: `context.d/${name}` });
      continue;
    }
    const retiredAs = retiredName(name, taken);
    taken.add(retiredAs);
    kept.push(retiredAs);
    ops.push({ type: "move", from: `context.d/${name}`, to: `context.d/retired/${retiredAs}` });
  }
  return { ops, retired: kept.sort() };
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
