/**
 * Agent Workspace - Loading agent identity files from R2
 * 
 * Each agent has a workspace in R2:
 *   agents/{agentId}/AGENTS.md   - Operating instructions
 *   agents/{agentId}/SOUL.md     - Identity/personality
 *   agents/{agentId}/USER.md     - Info about the human
 *   agents/{agentId}/MEMORY.md   - Long-term memory (main session only)
 *   agents/{agentId}/TOOLS.md    - Tool configuration notes
 * 
 * These files are loaded at session start and combined into the system prompt.
 */

export type WorkspaceFile = {
  path: string;
  content: string;
  exists: boolean;
};

export type AgentWorkspace = {
  agentId: string;
  agents?: WorkspaceFile;   // AGENTS.md
  soul?: WorkspaceFile;     // SOUL.md
  user?: WorkspaceFile;     // USER.md
  memory?: WorkspaceFile;   // MEMORY.md (only in main session)
  tools?: WorkspaceFile;    // TOOLS.md
  dailyMemory?: WorkspaceFile; // memory/YYYY-MM-DD.md
  yesterdayMemory?: WorkspaceFile; // memory/YYYY-MM-DD.md (yesterday)
  skills?: SkillSummary[];  // Available skills
};

export type SkillSummary = {
  name: string;
  description: string;
  location: string;  // Path to SKILL.md
  always?: boolean;  // Always include in prompt?
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
  const meaningfulLines = lines.filter(line => {
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
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  // Simple YAML parsing (key: value pairs only)
  const frontmatter: Record<string, unknown> = {};
  const yamlLines = match[1].split("\n");
  for (const line of yamlLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();
      // Parse booleans
      if (value === "true") value = true;
      else if (value === "false") value = false;
      frontmatter[key] = value;
    }
  }
  
  return { frontmatter, body: match[2] };
}

/**
 * Extract description from SKILL.md content
 * Looks for first paragraph after the title
 */
function extractSkillDescription(content: string): string {
  const { body } = parseFrontmatter(content);
  const lines = body.trim().split("\n");
  
  // Skip title (# line)
  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) i++;
  
  // Skip empty lines
  while (i < lines.length && !lines[i].trim()) i++;
  
  // Get first paragraph
  const descLines: string[] = [];
  while (i < lines.length && lines[i].trim()) {
    descLines.push(lines[i].trim());
    i++;
  }
  
  return descLines.join(" ").slice(0, 200);
}

/**
 * List skills from R2 (both agent-specific and global)
 */
async function listSkills(
  bucket: R2Bucket,
  agentId: string,
): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = [];
  
  // Check agent-specific skills: agents/{agentId}/skills/*/SKILL.md
  const agentSkillsPrefix = `agents/${agentId}/skills/`;
  const agentSkillsList = await bucket.list({ prefix: agentSkillsPrefix });
  
  for (const obj of agentSkillsList.objects) {
    if (obj.key.endsWith("/SKILL.md")) {
      const skillName = obj.key.split("/").slice(-2, -1)[0];
      const file = await loadR2File(bucket, obj.key);
      if (file.exists) {
        const { frontmatter } = parseFrontmatter(file.content);
        skills.push({
          name: (frontmatter.name as string) || skillName,
          description: (frontmatter.description as string) || extractSkillDescription(file.content),
          location: obj.key,
          always: frontmatter.always as boolean | undefined,
        });
      }
    }
  }
  
  // Check global skills: skills/*/SKILL.md
  const globalSkillsPrefix = `skills/`;
  const globalSkillsList = await bucket.list({ prefix: globalSkillsPrefix });
  
  for (const obj of globalSkillsList.objects) {
    if (obj.key.endsWith("/SKILL.md")) {
      const skillName = obj.key.split("/").slice(-2, -1)[0];
      // Skip if agent already has this skill (agent skills take precedence)
      if (skills.some(s => s.name === skillName)) continue;
      
      const file = await loadR2File(bucket, obj.key);
      if (file.exists) {
        const { frontmatter } = parseFrontmatter(file.content);
        skills.push({
          name: (frontmatter.name as string) || skillName,
          description: (frontmatter.description as string) || extractSkillDescription(file.content),
          location: obj.key,
          always: frontmatter.always as boolean | undefined,
        });
      }
    }
  }
  
  return skills;
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
  const [agents, soul, user, tools] = await Promise.all([
    loadR2File(bucket, `${basePath}/AGENTS.md`),
    loadR2File(bucket, `${basePath}/SOUL.md`),
    loadR2File(bucket, `${basePath}/USER.md`),
    loadR2File(bucket, `${basePath}/TOOLS.md`),
  ]);

  const workspace: AgentWorkspace = {
    agentId,
    agents: agents.exists ? agents : undefined,
    soul: soul.exists ? soul : undefined,
    user: user.exists ? user : undefined,
    tools: tools.exists ? tools : undefined,
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
  const skills = await listSkills(bucket, agentId);
  if (skills.length > 0) {
    workspace.skills = skills;
  }

  return workspace;
}

/**
 * Build a system prompt from workspace files
 * 
 * Order:
 * 1. Base system prompt (from config)
 * 2. SOUL.md - Who you are
 * 3. USER.md - Who you're helping
 * 4. AGENTS.md - How to operate
 * 5. MEMORY.md - Long-term memory (main session only)
 * 6. Daily memory - Recent context
 * 7. TOOLS.md - Tool notes
 */
export function buildSystemPromptFromWorkspace(
  basePrompt: string | undefined,
  workspace: AgentWorkspace,
): string {
  const sections: string[] = [];

  // Base system prompt
  if (basePrompt?.trim()) {
    sections.push(basePrompt.trim());
  }

  // SOUL.md - Identity (most important)
  if (workspace.soul?.exists) {
    sections.push(`## Your Identity\n\n${workspace.soul.content}`);
  }

  // USER.md - About the human
  if (workspace.user?.exists) {
    sections.push(`## About Your Human\n\n${workspace.user.content}`);
  }

  // AGENTS.md - Operating instructions
  if (workspace.agents?.exists) {
    sections.push(`## Operating Instructions\n\n${workspace.agents.content}`);
  }

  // MEMORY.md - Long-term memory (only in main session)
  if (workspace.memory?.exists) {
    sections.push(`## Long-Term Memory\n\n${workspace.memory.content}`);
  }

  // Daily memory - Recent context
  const dailyMemorySections: string[] = [];
  if (workspace.yesterdayMemory?.exists) {
    dailyMemorySections.push(`### Yesterday\n\n${workspace.yesterdayMemory.content}`);
  }
  if (workspace.dailyMemory?.exists) {
    dailyMemorySections.push(`### Today\n\n${workspace.dailyMemory.content}`);
  }
  if (dailyMemorySections.length > 0) {
    sections.push(`## Recent Context\n\n${dailyMemorySections.join("\n\n")}`);
  }

  // TOOLS.md - Tool configuration
  if (workspace.tools?.exists) {
    sections.push(`## Tool Notes\n\n${workspace.tools.content}`);
  }

  // Skills - Available capabilities
  if (workspace.skills && workspace.skills.length > 0) {
    const skillsSection = buildSkillsSection(workspace.skills);
    sections.push(skillsSection);
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Build the skills section for the system prompt
 * Lists available skills with descriptions - agent should read SKILL.md when needed
 */
function buildSkillsSection(skills: SkillSummary[]): string {
  const lines = [
    "## Skills (Mandatory Scan)",
    "",
    "Before responding, scan <available_skills> descriptions. If exactly one skill clearly applies, read its SKILL.md at <location> with the `Read` tool, then follow its instructions.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push(`  <skill name="${skill.name}"${skill.always ? ' always="true"' : ""}>`);
    lines.push(`    <description>${skill.description}</description>`);
    lines.push(`    <location>${skill.location}</location>`);
    lines.push(`  </skill>`);
  }

  lines.push("</available_skills>");

  return lines.join("\n");
}

/**
 * Write a file to the agent's workspace in R2
 */
export async function writeWorkspaceFile(
  bucket: R2Bucket,
  agentId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = `agents/${agentId}/${relativePath}`;
  await bucket.put(path, content, {
    httpMetadata: {
      contentType: "text/markdown",
    },
  });
  console.log(`[Workspace] Wrote ${path} (${content.length} bytes)`);
}

/**
 * Append to today's daily memory file
 */
export async function appendToDailyMemory(
  bucket: R2Bucket,
  agentId: string,
  entry: string,
): Promise<void> {
  const today = getDateString();
  const path = `agents/${agentId}/memory/${today}.md`;
  
  // Load existing content
  const existing = await loadR2File(bucket, path);
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0]; // HH:MM:SS
  const newContent = existing.exists 
    ? `${existing.content}\n\n---\n\n**${timestamp}**\n${entry}`
    : `# ${today}\n\n**${timestamp}**\n${entry}`;
  
  await bucket.put(path, newContent, {
    httpMetadata: {
      contentType: "text/markdown",
    },
  });
  console.log(`[Workspace] Appended to daily memory: ${path}`);
}

/**
 * Check if a session is the "main session" (direct DM with owner)
 * 
 * Main session criteria:
 * - DM (not group)
 * - Channel matches configured "main" channel
 * - Peer matches configured owner ID
 * 
 * For simplicity, we currently consider any DM on CLI as main session.
 * This can be made configurable later.
 */
export function isMainSession(
  sessionKey: string,
  _config?: { mainChannel?: string; ownerId?: string },
): boolean {
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
