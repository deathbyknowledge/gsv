import {
  CAPABILITY_IDS,
  HOST_ROLES,
  type CapabilityId,
  type HostRole,
  RuntimeNodeInventory,
  ToolDefinition,
} from "../protocol/tools";
import type { SkillEntryConfig } from "../config";
import type { CustomMetadata, SkillSummary } from "../skills";
import { isHeartbeatFileEmpty, type AgentWorkspace } from "./loader";
import { NATIVE_TOOL_PREFIX } from "./tools/constants";

import type { SessionChannelContext } from "../protocol/channel";

export type PromptRuntimeInfo = {
  agentId: string;
  sessionKey?: string;
  isMainSession: boolean;
  model?: {
    provider: string;
    id: string;
  };
  nodes?: RuntimeNodeInventory;
  channelContext?: SessionChannelContext;
  userTimezone?: string;
};

export type BuildPromptOptions = {
  tools?: ToolDefinition[];
  heartbeatPrompt?: string;
  skillEntries?: Record<string, SkillEntryConfig>;
  configRoot?: unknown;
  runtime?: PromptRuntimeInfo;
};

const DEFAULT_BASE_PROMPT =
  "You are a helpful AI assistant running inside GSV.";

/**
 * Build a system prompt from workspace files
 *
 * Order (when BOOTSTRAP.md exists - first run):
 * 1. Core prompt scaffold (base prompt + tooling + style + safety + workspace)
 * 2. BOOTSTRAP.md - Commissioning ceremony
 * 3. SOUL/IDENTITY/USER context
 * 4. Heartbeat and runtime context
 *
 * Order (normal operation):
 * 1. Core prompt scaffold (base prompt + tooling + style + safety + workspace)
 * 2. SOUL.md - Who you are
 * 3. IDENTITY.md - Name/class/profile
 * 4. USER.md - Who you're helping
 * 5. AGENTS.md - How to operate
 * 6. MEMORY.md - Long-term memory (main session only)
 * 7. Daily memory - Recent context
 * 8. TOOLS.md - Tool notes
 * 9. HEARTBEAT.md - Heartbeat notes (if present)
 * 10. Skills section
 * 11. Runtime context
 */
export function buildSystemPromptFromWorkspace(
  basePrompt: string | undefined,
  workspace: AgentWorkspace,
  options?: BuildPromptOptions,
): string {
  const sections: string[] = [];
  const resolvedBasePrompt = basePrompt?.trim() || DEFAULT_BASE_PROMPT;

  sections.push(resolvedBasePrompt);
  sections.push(buildToolingSection(options?.tools));
  sections.push(buildToolCallStyleSection());
  sections.push(buildSafetySection());
  sections.push(buildWorkspaceSection(workspace.agentId));
  sections.push(buildWorkspaceFilesSection());

  // BOOTSTRAP.md - First run commissioning ceremony
  // Keep the core scaffold above, then prioritize commissioning instructions.
  if (workspace.bootstrap?.exists) {
    sections.push(
      `## COMMISSIONING CEREMONY (First Run)\n\n**IMPORTANT: BOOTSTRAP.md exists. This is your first activation. Follow the commissioning ceremony below before doing anything else.**\n\n${workspace.bootstrap.content}`,
    );

    // Still include SOUL.md if it exists (might have defaults)
    if (workspace.soul?.exists) {
      sections.push(
        `## Current Soul (update during commissioning)\n\n${workspace.soul.content}`,
      );
    }

    // Include IDENTITY.md template
    if (workspace.identity?.exists) {
      sections.push(
        `## Current Identity (fill in during commissioning)\n\n${workspace.identity.content}`,
      );
    }

    // Include basic info about the human if known
    if (workspace.user?.exists) {
      sections.push(`## About Your Human\n\n${workspace.user.content}`);
    }

    const heartbeatSection = buildHeartbeatSection(
      workspace,
      options?.heartbeatPrompt,
    );
    if (heartbeatSection) {
      sections.push(heartbeatSection);
    }

    const runtimeSection = buildRuntimeSection(options?.runtime);
    if (runtimeSection) {
      sections.push(runtimeSection);
    }

    return joinSections(sections);
  }

  // Normal operation (no BOOTSTRAP.md)

  // SOUL.md - Core values and personality
  if (workspace.soul?.exists) {
    sections.push(`## Your Soul\n\n${workspace.soul.content}`);
  }

  // IDENTITY.md - Name, class, emoji
  if (workspace.identity?.exists) {
    sections.push(`## Your Identity\n\n${workspace.identity.content}`);
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
    dailyMemorySections.push(
      `### Yesterday\n\n${workspace.yesterdayMemory.content}`,
    );
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

  const heartbeatSection = buildHeartbeatSection(
    workspace,
    options?.heartbeatPrompt,
  );
  if (heartbeatSection) {
    sections.push(heartbeatSection);
  }

  // Skills - Available capabilities
  if (workspace.skills && workspace.skills.length > 0) {
    const readToolName = resolveWorkspaceReadToolName(options?.tools);
    const skillsSection = buildSkillsSection(workspace.skills, {
      agentId: workspace.agentId,
      readToolName,
      skillEntries: options?.skillEntries,
      configRoot: options?.configRoot,
      runtimeNodes: options?.runtime?.nodes,
    });
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  const runtimeSection = buildRuntimeSection(options?.runtime);
  if (runtimeSection) {
    sections.push(runtimeSection);
  }

  return joinSections(sections);
}

function joinSections(sections: string[]): string {
  return sections
    .filter((section) => section.trim().length > 0)
    .join("\n\n---\n\n");
}

function summarizeToolDescription(description: string): string {
  const singleLine = description.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 180) {
    return singleLine;
  }
  return `${singleLine.slice(0, 177)}...`;
}

function buildToolingSection(tools: ToolDefinition[] | undefined): string {
  const nativeToolCount =
    tools?.filter((tool) => tool.name.startsWith(NATIVE_TOOL_PREFIX)).length ??
    0;
  const namespacedNodeToolCount =
    tools?.filter(
      (tool) =>
        tool.name.includes("__") && !tool.name.startsWith(NATIVE_TOOL_PREFIX),
    ).length ?? 0;
  const lines = [
    "## Tooling",
    "Tool availability for this run is defined by the tool list passed at runtime.",
    "Tool names are case-sensitive. Call tools exactly by their provided names.",
  ];

  if (!tools || tools.length === 0) {
    lines.push("No tools are attached to this run.");
    return lines.join("\n");
  }

  lines.push(
    `Native tools: ${nativeToolCount}. Node tools: ${namespacedNodeToolCount}.`,
  );
  lines.push(
    "`gsv__*` tools are native Gateway tools. `<nodeId>__<toolName>` tools target a specific connected node.",
  );
  lines.push("Available tools:");
  for (const tool of tools) {
    const description = tool.description?.trim();
    lines.push(
      description
        ? `- ${tool.name}: ${summarizeToolDescription(description)}`
        : `- ${tool.name}`,
    );
  }

  return lines.join("\n");
}

function buildToolCallStyleSection(): string {
  return [
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls; run them directly.",
    "Narrate briefly when it adds value: multi-step plans, risky/destructive actions, or when the user asks for explanation.",
    "After tools complete, summarize concrete outcomes and next action.",
  ].join("\n");
}

function buildSafetySection(): string {
  return [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking.",
    "Never bypass safeguards, access controls, or sandbox boundaries.",
    "If a destructive action is requested but intent is ambiguous, ask for confirmation first.",
  ].join("\n");
}

function buildWorkspaceSection(agentId: string): string {
  return [
    "## Workspace",
    `Agent workspace root: agents/${agentId}/`,
    "Use workspace tools for persistent agent files, memory notes, and local skill overrides.",
    "Virtual skill paths are under skills/. Reads resolve agent override first, then global skills fallback.",
    "Writes to skills/* always create or update agent-local overrides under agents/<agentId>/skills/*.",
  ].join("\n");
}

function buildWorkspaceFilesSection(): string {
  return [
    "## Workspace Files (Injected)",
    "These user-editable files are loaded when present and injected below as separate sections.",
    "Core files: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md.",
    "Memory files: MEMORY.md (main sessions only) and daily memory notes.",
  ].join("\n");
}

function buildHeartbeatSection(
  workspace: AgentWorkspace,
  heartbeatPrompt: string | undefined,
): string | undefined {
  const hasHeartbeatPrompt = Boolean(heartbeatPrompt?.trim());
  const hasHeartbeatFile =
    workspace.heartbeat?.exists &&
    !isHeartbeatFileEmpty(workspace.heartbeat.content);

  if (!hasHeartbeatPrompt && !hasHeartbeatFile) {
    return undefined;
  }

  const lines = [
    "## Heartbeats",
    "When you receive a heartbeat poll and nothing needs attention, reply exactly: HEARTBEAT_OK.",
  ];

  if (hasHeartbeatPrompt) {
    lines.push(`Configured heartbeat prompt: ${heartbeatPrompt?.trim()}`);
  }

  if (hasHeartbeatFile) {
    lines.push("", "### HEARTBEAT.md", workspace.heartbeat!.content);
  }

  return lines.join("\n");
}

function buildRuntimeSection(
  runtime: PromptRuntimeInfo | undefined,
): string | undefined {
  if (!runtime) {
    return undefined;
  }

  const lines = [
    "## Runtime",
    `Agent: ${runtime.agentId}`,
    `Session: ${runtime.isMainSession ? "main" : "non-main"}`,
  ];

  if (runtime.sessionKey) {
    lines.push(`Session key: ${runtime.sessionKey}`);
  }

  if (runtime.model) {
    lines.push(`Model: ${runtime.model.provider}/${runtime.model.id}`);
  }

  if (runtime.userTimezone) {
    lines.push(`Timezone: ${runtime.userTimezone}`);
  }

  if (runtime.channelContext) {
    lines.push(`Channel: ${runtime.channelContext.channel}`);
  }

  if (runtime.nodes) {
    const executionHosts = runtime.nodes.hosts
      .filter((host) => host.hostRole === "execution")
      .map((host) => host.nodeId)
      .sort();
    const selectedExecutionHost = runtime.nodes.executionHostId;
    if (
      selectedExecutionHost &&
      !executionHosts.includes(selectedExecutionHost)
    ) {
      executionHosts.unshift(selectedExecutionHost);
    }

    lines.push(
      `Primary execution host: ${selectedExecutionHost ?? "none selected"}`,
    );
    lines.push(
      `Execution hosts: ${executionHosts.length > 0 ? executionHosts.join(", ") : "none"}`,
    );
    lines.push(
      `Specialized hosts: ${runtime.nodes.specializedHostIds.length > 0 ? runtime.nodes.specializedHostIds.join(", ") : "none"}`,
    );
    lines.push(
      "Capabilities are internal routing metadata. Do not call capability IDs as tools; call only listed tool names.",
    );

    if (runtime.nodes.hosts.length > 0) {
      lines.push("Connected hosts:");
      for (const host of runtime.nodes.hosts) {
        const capabilities =
          host.hostCapabilities.length > 0
            ? host.hostCapabilities.join(", ")
            : "none";
        const toolNames =
          host.tools.length > 0 ? host.tools.join(", ") : "none";
        const os = host.hostOs ? ` os=${host.hostOs}` : "";
        const envCount = host.hostEnv?.length ?? 0;
        const binCount = host.hostBins?.length ?? 0;
        lines.push(
          `- ${host.nodeId} (${host.hostRole})${os} envKeys=${envCount} bins=${binCount} capabilities=[${capabilities}] tools=[${toolNames}]`,
        );
      }
    }
  }

  return lines.join("\n");
}

function resolveWorkspaceReadToolName(
  tools: ToolDefinition[] | undefined,
): string {
  if (!tools || tools.length === 0) {
    return "gsv__ReadFile";
  }

  const match = tools.find(
    (tool) => tool.name.toLowerCase() === "gsv__readfile",
  );
  return match?.name || "gsv__ReadFile";
}

function resolveSkillReadPath(
  location: string,
  agentId: string,
): string | null {
  if (!location.endsWith("/SKILL.md")) {
    return null;
  }

  const agentPrefix = `agents/${agentId}/skills/`;
  if (location.startsWith(agentPrefix)) {
    return `skills/${location.slice(agentPrefix.length)}`;
  }

  if (location.startsWith("skills/")) {
    return location;
  }

  return null;
}

const CAPABILITY_SET = new Set<string>(CAPABILITY_IDS);
const HOST_ROLE_SET = new Set<string>(HOST_ROLES);
export type SkillRuntimeRequirements = {
  hostRoles: HostRole[];
  capabilities: CapabilityId[];
  anyCapabilities: CapabilityId[];
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
};

export type EffectiveSkillPolicy = {
  always: boolean;
  hasInvalidRequirements: boolean;
  requires?: SkillRuntimeRequirements;
};

type NormalizedRequirementList<T extends string> = {
  values: T[];
  hasInvalid: boolean;
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizeFreeformRequirementList(
  value: unknown,
): NormalizedRequirementList<string> {
  if (value === undefined) {
    return { values: [], hasInvalid: false };
  }
  if (!Array.isArray(value)) {
    return { values: [], hasInvalid: true };
  }

  const values: string[] = [];
  let hasInvalid = false;
  for (const entry of value) {
    if (typeof entry !== "string") {
      hasInvalid = true;
      continue;
    }

    const normalized = entry.trim();
    if (normalized.length === 0) {
      hasInvalid = true;
      continue;
    }

    values.push(normalized);
  }

  return { values: Array.from(new Set(values)), hasInvalid };
}

function normalizeCapabilityRequirementList(
  value: unknown,
): NormalizedRequirementList<CapabilityId> {
  if (value === undefined) {
    return { values: [], hasInvalid: false };
  }
  if (!Array.isArray(value)) {
    return { values: [], hasInvalid: true };
  }

  const values: CapabilityId[] = [];
  let hasInvalid = false;
  for (const entry of value) {
    if (typeof entry !== "string") {
      hasInvalid = true;
      continue;
    }

    const normalized = entry.trim();
    if (normalized.length === 0) {
      hasInvalid = true;
      continue;
    }

    if (!CAPABILITY_SET.has(normalized)) {
      hasInvalid = true;
      continue;
    }

    values.push(normalized as CapabilityId);
  }

  return { values: Array.from(new Set(values)), hasInvalid };
}

function normalizeHostRoleRequirementList(
  value: unknown,
): NormalizedRequirementList<HostRole> {
  if (value === undefined) {
    return { values: [], hasInvalid: false };
  }
  if (!Array.isArray(value)) {
    return { values: [], hasInvalid: true };
  }

  const values: HostRole[] = [];
  let hasInvalid = false;
  for (const entry of value) {
    if (typeof entry !== "string") {
      hasInvalid = true;
      continue;
    }

    const normalized = entry.trim();
    if (normalized.length === 0) {
      hasInvalid = true;
      continue;
    }

    if (!HOST_ROLE_SET.has(normalized)) {
      hasInvalid = true;
      continue;
    }

    values.push(normalized as HostRole);
  }

  return { values: Array.from(new Set(values)), hasInvalid };
}

function resolveSkillKeyFromLocation(location: string): string | undefined {
  if (!location.endsWith("/SKILL.md")) {
    return undefined;
  }

  const trimmed = location.slice(0, -"/SKILL.md".length);
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) {
    return undefined;
  }
  const key = trimmed.slice(idx + 1).trim();
  return key.length > 0 ? key : undefined;
}

function resolveSkillEntryConfig(
  skill: SkillSummary,
  skillEntries: Record<string, SkillEntryConfig> | undefined,
): SkillEntryConfig | undefined {
  if (!skillEntries) {
    return undefined;
  }

  const locationKey = resolveSkillKeyFromLocation(skill.location);
  const candidates = [skill.name, locationKey, skill.location].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (Object.prototype.hasOwnProperty.call(skillEntries, candidate)) {
      return skillEntries[candidate];
    }
  }

  return undefined;
}

function resolveSkillMetadataManifest(
  skill: SkillSummary,
): CustomMetadata | undefined {
  return skill.metadata?.gsv ?? skill.metadata?.openclaw ?? skill.metadata?.clawdbot;
}

export function resolveEffectiveSkillPolicy(
  skill: SkillSummary,
  skillEntries: Record<string, SkillEntryConfig> | undefined,
): EffectiveSkillPolicy | undefined {
  const entryConfig = resolveSkillEntryConfig(skill, skillEntries);
  if (entryConfig?.enabled === false) {
    return undefined;
  }

  const rawRequires = resolveSkillMetadataManifest(skill)?.requires as
    | Record<string, unknown>
    | undefined;
  const configRequires = entryConfig?.requires as
    | Record<string, unknown>
    | undefined;
  const requiredRoles = normalizeHostRoleRequirementList(
    configRequires?.hostRoles ?? rawRequires?.hostRoles,
  );
  const requiredCapabilities = normalizeCapabilityRequirementList(
    configRequires?.capabilities ?? rawRequires?.capabilities,
  );
  const requiredAnyCapabilities = normalizeCapabilityRequirementList(
    configRequires?.anyCapabilities ?? rawRequires?.anyCapabilities,
  );
  const requiredBins = normalizeFreeformRequirementList(
    configRequires?.bins ?? rawRequires?.bins,
  );
  const requiredAnyBins = normalizeFreeformRequirementList(
    configRequires?.anyBins ?? rawRequires?.anyBins,
  );
  const requiredEnv = normalizeFreeformRequirementList(
    configRequires?.env ?? rawRequires?.env,
  );
  const requiredConfig = normalizeFreeformRequirementList(
    configRequires?.config ?? rawRequires?.config,
  );
  const requiredOs = normalizeFreeformRequirementList(
    configRequires?.os ?? rawRequires?.os,
  );
  const always =
    typeof entryConfig?.always === "boolean"
      ? entryConfig.always
      : skill.always === true;
  const hasRequirements =
    requiredRoles.values.length > 0 ||
    requiredCapabilities.values.length > 0 ||
    requiredAnyCapabilities.values.length > 0 ||
    requiredBins.values.length > 0 ||
    requiredAnyBins.values.length > 0 ||
    requiredEnv.values.length > 0 ||
    requiredConfig.values.length > 0 ||
    requiredOs.values.length > 0;
  const hasInvalidRequirements =
    requiredRoles.hasInvalid ||
    requiredCapabilities.hasInvalid ||
    requiredAnyCapabilities.hasInvalid ||
    requiredBins.hasInvalid ||
    requiredAnyBins.hasInvalid ||
    requiredEnv.hasInvalid ||
    requiredConfig.hasInvalid ||
    requiredOs.hasInvalid;

  return {
    always,
    hasInvalidRequirements,
    requires: hasRequirements
        ? {
          hostRoles: requiredRoles.values,
          capabilities: requiredCapabilities.values,
          anyCapabilities: requiredAnyCapabilities.values,
          bins: requiredBins.values,
          anyBins: requiredAnyBins.values,
          env: requiredEnv.values,
          config: requiredConfig.values,
          os: requiredOs.values.map((value) => value.toLowerCase()),
        }
      : undefined,
  };
}

function getConfigValueByPath(configRoot: unknown, path: string): unknown {
  if (!path.trim()) {
    return undefined;
  }

  const parts = path.split(".");
  let current: unknown = configRoot;
  for (const part of parts) {
    if (!part) {
      return undefined;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !(part in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isTruthyConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

export type SkillEligibilityEvaluation = {
  eligible: boolean;
  matchingHostIds: string[];
  reasons: string[];
};

export function evaluateSkillEligibility(
  policy: EffectiveSkillPolicy,
  runtimeNodes: RuntimeNodeInventory | undefined,
  configRoot?: unknown,
): SkillEligibilityEvaluation {
  if (policy.always) {
    return { eligible: true, matchingHostIds: [], reasons: [] };
  }
  if (policy.hasInvalidRequirements) {
    return {
      eligible: false,
      matchingHostIds: [],
      reasons: ["invalid requirement identifiers"],
    };
  }

  const requires = policy.requires;
  if (!requires) {
    return { eligible: true, matchingHostIds: [], reasons: [] };
  }

  if (!runtimeNodes || runtimeNodes.hosts.length === 0) {
    return {
      eligible: false,
      matchingHostIds: [],
      reasons: ["no connected hosts"],
    };
  }

  const reasons: string[] = [];
  let candidateHosts = runtimeNodes.hosts;
  if (requires.hostRoles.length > 0) {
    candidateHosts = candidateHosts.filter((host) =>
      requires.hostRoles.includes(host.hostRole),
    );
    if (candidateHosts.length === 0) {
      reasons.push(`requires hostRoles: ${requires.hostRoles.join(", ")}`);
    }
  }

  if (requires.capabilities.length > 0) {
    candidateHosts = candidateHosts.filter((host) =>
      requires.capabilities.every((capability) =>
        host.hostCapabilities.includes(capability),
      ),
    );
    if (candidateHosts.length === 0) {
      reasons.push(`requires capabilities: ${requires.capabilities.join(", ")}`);
    }
  }

  if (requires.anyCapabilities.length > 0) {
    candidateHosts = candidateHosts.filter((host) =>
      requires.anyCapabilities.some((capability) =>
        host.hostCapabilities.includes(capability),
      ),
    );
    if (candidateHosts.length === 0) {
      reasons.push(
        `requires anyCapabilities: ${requires.anyCapabilities.join(", ")}`,
      );
    }
  }

  if (requires.os.length > 0) {
    candidateHosts = candidateHosts.filter((host) => {
      const os = host.hostOs?.trim().toLowerCase();
      return os ? requires.os.includes(os) : false;
    });
    if (candidateHosts.length === 0) {
      reasons.push(`requires os: ${requires.os.join(", ")}`);
    }
  }

  if (requires.env.length > 0) {
    candidateHosts = candidateHosts.filter((host) => {
      const hostEnv = new Set((host.hostEnv ?? []).map((key) => key.trim()));
      return requires.env.every((envKey) => hostEnv.has(envKey));
    });
    if (candidateHosts.length === 0) {
      reasons.push(`requires env: ${requires.env.join(", ")}`);
    }
  }

  if (requires.bins.length > 0) {
    candidateHosts = candidateHosts.filter((host) => {
      const status = host.hostBinStatus ?? {};
      return requires.bins.every((bin) => status[bin] === true);
    });
    if (candidateHosts.length === 0) {
      reasons.push(`requires bins: ${requires.bins.join(", ")}`);
    }
  }

  if (requires.anyBins.length > 0) {
    candidateHosts = candidateHosts.filter((host) => {
      const status = host.hostBinStatus ?? {};
      return requires.anyBins.some((bin) => status[bin] === true);
    });
    if (candidateHosts.length === 0) {
      reasons.push(`requires anyBins: ${requires.anyBins.join(", ")}`);
    }
  }

  if (requires.config.length > 0) {
    const missingConfig = requires.config.filter((path) => {
      const value = getConfigValueByPath(configRoot, path);
      return !isTruthyConfigValue(value);
    });
    if (missingConfig.length > 0) {
      reasons.push(`requires config: ${missingConfig.join(", ")}`);
    }
  }

  const eligible = candidateHosts.length > 0 && reasons.length === 0;
  return {
    eligible,
    matchingHostIds: candidateHosts.map((host) => host.nodeId).sort(),
    reasons,
  };
}

/**
 * Build the skills section for the system prompt
 * Lists available capabilities the agent can load on demand.
 */
function buildSkillsSection(
  skills: SkillSummary[],
  options: {
    agentId: string;
    readToolName: string;
    skillEntries?: Record<string, SkillEntryConfig>;
    configRoot?: unknown;
    runtimeNodes?: RuntimeNodeInventory;
  },
): string {
  const readableSkills = skills
    .map((skill) => ({
      skill,
      readPath: resolveSkillReadPath(skill.location, options.agentId),
    }))
    .filter(
      (
        entry,
      ): entry is {
        skill: SkillSummary;
        readPath: string;
      } => entry.readPath !== null,
    );

  const configEligibleSkills = readableSkills
    .map((entry) => ({
      ...entry,
      policy: resolveEffectiveSkillPolicy(entry.skill, options.skillEntries),
    }))
    .filter(
      (
        entry,
      ): entry is {
        skill: SkillSummary;
        readPath: string;
        policy: EffectiveSkillPolicy;
      } => entry.policy !== undefined,
    );

  const validRequirementSkills = configEligibleSkills.filter(
    (entry) => !entry.policy.hasInvalidRequirements || entry.policy.always,
  );

  const runtimeEligibleSkills = validRequirementSkills.map((entry) => ({
    ...entry,
    evaluation: evaluateSkillEligibility(
      entry.policy,
      options.runtimeNodes,
      options.configRoot,
    ),
  }));

  const eligibleSkills = runtimeEligibleSkills.filter(
    (entry) => entry.evaluation.eligible,
  );

  if (eligibleSkills.length === 0) {
    return "";
  }

  const configFilteredCount =
    readableSkills.length - configEligibleSkills.length;
  const invalidRequirementFilteredCount =
    configEligibleSkills.length - validRequirementSkills.length;
  const runtimeFilteredCount =
    runtimeEligibleSkills.length - eligibleSkills.length;

  const lines = [
    "## Skills (Mandatory Scan)",
    "",
    "Before responding, scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read SKILL.md with \`${options.readToolName}\` using <read_path>, then follow it.`,
    "- If multiple skills could apply: choose the single most specific skill first.",
    "- If none clearly apply: do not load a skill.",
    "Constraints: read at most one skill up front; only read after selecting.",
    ...(configFilteredCount > 0
      ? [
          `Config filter: ${configFilteredCount} skill(s) hidden by skills.entries policy.`,
        ]
      : []),
    ...(invalidRequirementFilteredCount > 0
      ? [
          `Requirement filter: ${invalidRequirementFilteredCount} skill(s) hidden due invalid runtime requirement identifiers.`,
        ]
      : []),
    ...(runtimeFilteredCount > 0
      ? [
          `Runtime filter: ${runtimeFilteredCount} skill(s) hidden due unmet runtime capability requirements.`,
        ]
      : []),
    "",
    "<available_skills>",
  ];

  for (const { skill, readPath, policy } of eligibleSkills) {
    lines.push(
      `  <skill name="${skill.name}"${policy.always ? ' always="true"' : ""}>`,
    );
    lines.push(`    <description>${skill.description}</description>`);
    lines.push(`    <location>${skill.location}</location>`);
    lines.push(`    <read_path>${readPath}</read_path>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");

  return lines.join("\n");
}
