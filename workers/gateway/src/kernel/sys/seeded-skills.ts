import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RipgitApplyOp, RipgitClient, RipgitRepoRef } from "../../fs";
import { reconcileHomeOnce } from "../account-home";
import type { KernelContext } from "../context";
import { BUILTIN_SKILL_NAMES, readSystemSkillPath } from "./builtin-skills";
import { SHIPPED_BUILTIN_SKILL_SHA256S } from "./shipped-skill-revisions";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const SHIPPED_REVISIONS = new Map<string, readonly string[]>(Object.entries(SHIPPED_BUILTIN_SKILL_SHA256S));

/**
 * Built-in skills used to be copied into homes; the system layer now serves
 * them. Once per account and Kernel lifetime, an untouched copy is deleted and
 * an edited one is kept under a new name, so it no longer claims a built-in name.
 */
export function retireSeededSkills(
  ctx: Pick<KernelContext, "env" | "auth">,
  identity: ProcessIdentity,
): Promise<void> {
  return reconcileHomeOnce(ctx, identity, "gsv: retire copied built-in skills", seededSkillCleanupOps);
}

export async function seededSkillCleanupOps(
  client: Pick<RipgitClient, "readPath">,
  repo: RipgitRepoRef,
): Promise<RipgitApplyOp[]> {
  const root = await client.readPath(repo, "skills.d");
  if (root.kind !== "tree") return [];
  const taken = new Set(root.entries.map((entry) => entry.name));
  const copies = root.entries
    .filter((entry) => entry.type === "tree" && BUILTIN_SKILL_NAMES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const ops: RipgitApplyOp[] = [];
  for (const name of copies) {
    const [directory, skill] = await Promise.all([
      client.readPath(repo, `skills.d/${name}`),
      client.readPath(repo, `skills.d/${name}/SKILL.md`),
    ]);
    if (directory.kind !== "tree" || skill.kind !== "file") continue;
    if (directory.entries.every((entry) => entry.name === "SKILL.md") && await isShippedRevision(name, skill.bytes)) {
      ops.push({ type: "delete", path: `skills.d/${name}`, recursive: true });
      continue;
    }
    const renamed = customName(name, taken);
    taken.add(renamed);
    ops.push({ type: "move", from: `skills.d/${name}`, to: `skills.d/${renamed}` });
    ops.push({
      type: "put",
      path: `skills.d/${renamed}/SKILL.md`,
      contentBytes: Array.from(TEXT_ENCODER.encode(renameSkill(TEXT_DECODER.decode(skill.bytes), name, renamed))),
    });
  }
  return ops;
}

async function isShippedRevision(name: string, bytes: Uint8Array): Promise<boolean> {
  const hash = await sha256Hex(bytes);
  const current = readSystemSkillPath(`/sys/skills.d/${name}/SKILL.md`);
  return SHIPPED_REVISIONS.get(name)?.includes(hash) === true
    || (current.kind === "file" && hash === await sha256Hex(TEXT_ENCODER.encode(current.content)));
}

function customName(name: string, taken: ReadonlySet<string>): string {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? `${name}-custom` : `${name}-custom-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Renames the skill in its frontmatter so the kept copy stops claiming the built-in name. */
function renameSkill(content: string, from: string, to: string): string {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return content;
  for (let index = 1; index < lines.length && lines[index].trim() !== "---"; index += 1) {
    if (/^name:\s*["']?([^"'\s]+)["']?\s*$/.exec(lines[index])?.[1] === from) {
      lines[index] = `name: ${to}`;
      break;
    }
  }
  return lines.join("\n");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
