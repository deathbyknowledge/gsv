import { listWorkspaceSkills, type SkillSummary } from "../skills";

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

/**
 * Load HEARTBEAT.md for an agent
 */
export async function loadHeartbeatFile(
  bucket: R2Bucket,
  agentId: string,
): Promise<WorkspaceFile> {
  const path = `agents/${agentId}/HEARTBEAT.md`;
  return loadR2File(bucket, path);
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
): Promise<AgentWorkspace> {
  const basePath = `agents/${agentId}`;

  // Load core files in parallel
  const [agents, soul, identity, user, tools, heartbeat, bootstrap] =
    await Promise.all([
      loadR2File(bucket, `${basePath}/AGENTS.md`),
      loadR2File(bucket, `${basePath}/SOUL.md`),
      loadR2File(bucket, `${basePath}/IDENTITY.md`),
      loadR2File(bucket, `${basePath}/USER.md`),
      loadR2File(bucket, `${basePath}/TOOLS.md`),
      loadR2File(bucket, `${basePath}/HEARTBEAT.md`),
      loadR2File(bucket, `${basePath}/BOOTSTRAP.md`),
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
    const memory = await loadR2File(bucket, `${basePath}/MEMORY.md`);
    if (memory.exists) {
      workspace.memory = memory;
    }
  }

  // Load daily memory files (today + yesterday)
  const today = getDateString();
  const yesterday = getDateString(-1);

  const [dailyMemory, yesterdayMemory] = await Promise.all([
    loadR2File(bucket, `${basePath}/memory/${today}.md`),
    loadR2File(bucket, `${basePath}/memory/${yesterday}.md`),
  ]);

  if (dailyMemory.exists) {
    workspace.dailyMemory = dailyMemory;
  }
  if (yesterdayMemory.exists) {
    workspace.yesterdayMemory = yesterdayMemory;
  }

  // Load available skills
  const skills = await listWorkspaceSkills(bucket, agentId);
  if (skills.length > 0) {
    workspace.skills = skills;
  }

  return workspace;
}

export function isMainSession(sessionKey: string): boolean {
  // Parse session key: agent:{agentId}:{channel}:{peerKind}:{peerId}
  const parts = sessionKey.split(":");
  if (parts.length < 4) return false;

  const channel = parts[2];
  const peerKind = parts[3];

  // CLI sessions are always main (direct interaction)
  if (channel === "cli") return true;

  // DMs are main sessions (for now)
  // TODO: Make this configurable per-agent
  if (peerKind === "dm") return true;

  return false;
}
