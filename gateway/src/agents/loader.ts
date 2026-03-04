import { listWorkspaceSkills, type SkillSummary } from "../skills";
import { isMainSessionKey, type DmScope } from "../session/routing";
import {
  resolveWorkspaceFileCandidates,
  resolveWorkspacePathSet,
  resolveWorkspacePathSetForRuntime,
  type WorkspacePathSet,
} from "../storage/paths";

export type WorkspaceFile = {
  path: string;
  content: string;
  exists: boolean;
};

export type AgentWorkspace = {
  agentId: string;
  agents?: WorkspaceFile; // AGENTS.md
  soul?: WorkspaceFile; // SOUL.md
  identity?: WorkspaceFile; // IDENTITY.md
  user?: WorkspaceFile; // USER.md
  memory?: WorkspaceFile; // MEMORY.md (only in main session)
  tools?: WorkspaceFile; // TOOLS.md
  heartbeat?: WorkspaceFile; // HEARTBEAT.md
  bootstrap?: WorkspaceFile; // BOOTSTRAP.md (first-run commissioning)
  dailyMemory?: WorkspaceFile; // memory/YYYY-MM-DD.md
  yesterdayMemory?: WorkspaceFile; // memory/YYYY-MM-DD.md (yesterday)
  skills?: SkillSummary[]; // Available skills
};

/**
 * Load a text file from R2
 */
async function loadR2File(
  bucket: R2Bucket,
  path: string,
): Promise<WorkspaceFile> {
  const object = await bucket.get(path);
  if (!object) {
    return { path, content: "", exists: false };
  }
  const content = await object.text();
  return { path, content, exists: true };
}

async function loadR2FileWithFallback(
  bucket: R2Bucket,
  paths: string[],
): Promise<WorkspaceFile> {
  for (const path of paths) {
    const loaded = await loadR2File(bucket, path);
    if (loaded.exists) {
      return loaded;
    }
  }
  return {
    path: paths[0] ?? "",
    content: "",
    exists: false,
  };
}

/**
 * Load HEARTBEAT.md for an agent
 */
export async function loadHeartbeatFile(
  bucket: R2Bucket,
  agentId: string,
  spaceId?: string,
): Promise<WorkspaceFile> {
  const pathSet = await resolveWorkspacePathSetForRuntime(
    bucket,
    agentId,
    spaceId,
  );
  return loadR2FileWithFallback(
    bucket,
    resolveWorkspaceFileCandidates("HEARTBEAT.md", pathSet),
  );
}

/**
 * Check if a heartbeat file has meaningful content
 * Returns false if file is empty or only contains comments/headers
 */
export function isHeartbeatFileEmpty(content: string): boolean {
  if (!content || content.trim().length === 0) {
    return true;
  }

  // Remove markdown comments (HTML-style)
  let cleaned = content.replace(/<!--[\s\S]*?-->/g, "");

  // Remove lines that are only headers, whitespace, or dashes
  const lines = cleaned.split("\n");
  const meaningfulLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip empty lines
    if (trimmed.length === 0) return false;
    // Skip markdown headers
    if (/^#+\s*$/.test(trimmed)) return false;
    // Skip lines that are only dashes/equals (header underlines)
    if (/^[-=]+$/.test(trimmed)) return false;
    // Skip lines starting with # that have no content after
    if (/^#+\s*[-—–]+\s*$/.test(trimmed)) return false;
    // This line has content
    return true;
  });

  return meaningfulLines.length === 0;
}

/**
 * Get today's date in YYYY-MM-DD format
 */
function getDateString(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().split("T")[0];
}

/**
 * Load an agent's workspace from R2
 *
 * @param bucket - R2 bucket
 * @param agentId - Agent ID (e.g., "main", "work")
 * @param isMainSession - Whether this is the main session (loads MEMORY.md)
 */
export async function loadAgentWorkspace(
  bucket: R2Bucket,
  agentId: string,
  isMainSession: boolean = false,
  options?: {
    spaceId?: string;
    pathSet?: WorkspacePathSet;
  },
): Promise<AgentWorkspace> {
  const pathSet =
    options?.pathSet ??
    (options?.spaceId
      ? await resolveWorkspacePathSetForRuntime(bucket, agentId, options.spaceId)
      : resolveWorkspacePathSet(agentId));
  const fileCandidates = (fileName: string): string[] =>
    resolveWorkspaceFileCandidates(fileName, pathSet);

  // Load core files in parallel
  const [agents, soul, identity, user, tools, heartbeat, bootstrap] =
    await Promise.all([
      loadR2FileWithFallback(bucket, fileCandidates("AGENTS.md")),
      loadR2FileWithFallback(bucket, fileCandidates("SOUL.md")),
      loadR2FileWithFallback(bucket, fileCandidates("IDENTITY.md")),
      loadR2FileWithFallback(bucket, fileCandidates("USER.md")),
      loadR2FileWithFallback(bucket, fileCandidates("TOOLS.md")),
      loadR2FileWithFallback(bucket, fileCandidates("HEARTBEAT.md")),
      loadR2FileWithFallback(bucket, fileCandidates("BOOTSTRAP.md")),
    ]);

  const workspace: AgentWorkspace = {
    agentId,
    agents: agents.exists ? agents : undefined,
    soul: soul.exists ? soul : undefined,
    identity: identity.exists ? identity : undefined,
    user: user.exists ? user : undefined,
    tools: tools.exists ? tools : undefined,
    heartbeat: heartbeat.exists ? heartbeat : undefined,
    bootstrap: bootstrap.exists ? bootstrap : undefined,
  };

  // Load MEMORY.md only in main session (security: contains personal context)
  if (isMainSession) {
    const memory = await loadR2FileWithFallback(bucket, fileCandidates("MEMORY.md"));
    if (memory.exists) {
      workspace.memory = memory;
    }
  }

  // Load daily memory files (today + yesterday)
  const today = getDateString();
  const yesterday = getDateString(-1);

  const [dailyMemory, yesterdayMemory] = await Promise.all([
    loadR2FileWithFallback(bucket, fileCandidates(`memory/${today}.md`)),
    loadR2FileWithFallback(bucket, fileCandidates(`memory/${yesterday}.md`)),
  ]);

  if (dailyMemory.exists) {
    workspace.dailyMemory = dailyMemory;
  }
  if (yesterdayMemory.exists) {
    workspace.yesterdayMemory = yesterdayMemory;
  }

  // Load available skills
  const skills = await listWorkspaceSkills(bucket, agentId, { pathSet });
  if (skills.length > 0) {
    workspace.skills = skills;
  }

  return workspace;
}

export function isMainSession(
  sessionKey: string,
  opts?: { mainKey?: string; dmScope?: DmScope },
): boolean {
  return isMainSessionKey({
    sessionKey,
    mainKey: opts?.mainKey,
    dmScope: opts?.dmScope,
  });
}
