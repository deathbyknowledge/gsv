import { describe, expect, it } from "vitest";
import { buildSystemPromptFromWorkspace } from "./prompt";
import type { AgentWorkspace, WorkspaceFile } from "./loader";
import type { RuntimeNodeInventory, ToolDefinition } from "../protocol/tools";

declare const __PRINT_FULL_PROMPT__: boolean;

function file(path: string, content: string): WorkspaceFile {
  return { path, content, exists: true };
}

function maybePrintPrompt(prompt: string): void {
  if (__PRINT_FULL_PROMPT__ === true) {
    console.log("\n========== FULL PROMPT FIXTURE ==========\n");
    console.log(prompt);
    console.log("\n========== END PROMPT FIXTURE ==========\n");
  }
}

describe("buildSystemPromptFromWorkspace full fixture", () => {
  it("renders a full prompt fixture and matches exactly", () => {
    const tools: ToolDefinition[] = [
      {
        name: "gsv__ReadFile",
        description: "Read files from the workspace.",
        inputSchema: { type: "object" },
      },
      {
        name: "gsv__WriteFile",
        description: "Write files to the workspace.",
        inputSchema: { type: "object" },
      },
      {
        name: "macbook__Bash",
        description: "Execute shell commands on the macbook node.",
        inputSchema: { type: "object" },
      },
      {
        name: "macbook__Read",
        description: "Read files on the macbook node.",
        inputSchema: { type: "object" },
      },
      {
        name: "macbook__Write",
        description: "Write files on the macbook node.",
        inputSchema: { type: "object" },
      },
    ];

    const workspace: AgentWorkspace = {
      agentId: "main",
      soul: file("agents/main/SOUL.md", "Be direct, calm, and practical."),
      identity: file(
        "agents/main/IDENTITY.md",
        "Name: Atlas\nClass: systems collaborator",
      ),
      user: file("agents/main/USER.md", "You assist Sam."),
      agents: file(
        "agents/main/AGENTS.md",
        "Prioritize correctness over speed; explain tradeoffs briefly.",
      ),
      memory: file("agents/main/MEMORY.md", "- Last week: stabilized deploy flow."),
      yesterdayMemory: file(
        "agents/main/memory/2026-02-28.md",
        "- Audited node routing edge cases.",
      ),
      dailyMemory: file(
        "agents/main/memory/2026-03-01.md",
        "- Refactoring node service boundaries.",
      ),
      tools: file("agents/main/TOOLS.md", "- Prefer gsv__ReadFile before edits."),
      heartbeat: file(
        "agents/main/HEARTBEAT.md",
        "Check for pending follow-ups and stalled tasks.",
      ),
      skills: [
        {
          name: "deploy-checklist",
          description: "Release checklist and rollback playbook.",
          location: "skills/deploy-checklist/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                capabilities: ["shell.exec"],
              },
            },
          },
        },
        {
          name: "iphone-search",
          description: "Investigate messages on iPhone mirror.",
          location: "skills/iphone-search/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                capabilities: ["text.search"],
              },
            },
          },
        },
        {
          name: "invalid-capability",
          description: "Broken metadata example.",
          location: "skills/invalid-capability/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                capabilities: ["shell.exe"],
              },
            },
          },
        },
        {
          name: "disabled-skill",
          description: "Disabled by config entry.",
          location: "skills/disabled-skill/SKILL.md",
        },
      ],
    };

    const nodes: RuntimeNodeInventory = {
      hosts: [
        {
          nodeId: "macbook",
          online: true,
          hostCapabilities: [
            "filesystem.list",
            "filesystem.read",
            "filesystem.write",
            "shell.exec",
          ],
          toolCapabilities: {
            Bash: ["shell.exec"],
            Read: ["filesystem.read"],
            Write: ["filesystem.write"],
          },
          tools: ["Bash", "Read", "Write"],
          firstSeenAt: 1699990000000,
          lastSeenAt: 1700001000000,
          lastConnectedAt: 1700000900000,
          clientPlatform: "darwin-arm64",
          clientVersion: "0.2.1",
        },
        {
          nodeId: "homelab",
          online: false,
          hostCapabilities: [
            "filesystem.list",
            "filesystem.read",
            "filesystem.write",
            "shell.exec",
          ],
          toolCapabilities: {
            Bash: ["shell.exec"],
          },
          tools: ["Bash"],
          firstSeenAt: 1680000000000,
          lastSeenAt: 1700000000000,
          lastDisconnectedAt: 1700000000000,
          clientPlatform: "linux-x64",
          clientVersion: "0.2.0",
        },
        {
          nodeId: "iphone",
          online: false,
          hostCapabilities: ["text.search"],
          toolCapabilities: {
            SearchMessages: ["text.search"],
          },
          tools: ["SearchMessages"],
          firstSeenAt: 1695000000000,
          lastSeenAt: 1700000500000,
          lastDisconnectedAt: 1700000200000,
          clientPlatform: "ios",
          clientVersion: "0.1.0",
        },
      ],
    };

    const prompt = buildSystemPromptFromWorkspace(
      "You are Atlas, a pragmatic assistant for Sam.",
      workspace,
      {
        tools,
        heartbeatPrompt: "Check for stale follow-ups and urgent notices.",
        skillEntries: {
          "disabled-skill": { enabled: false },
        },
        runtime: {
          agentId: "main",
          sessionKey: "agent:main:cli:dm:sam",
          isMainSession: true,
          model: { provider: "anthropic", id: "claude-sonnet-4" },
          userTimezone: "America/Los_Angeles",
          channelContext: {
            channel: "discord",
            accountId: "acct-1",
            peer: {
              kind: "dm",
              id: "sam",
              name: "Sam",
            },
          },
          nodes,
        },
      },
    );

    maybePrintPrompt(prompt);
    expect(prompt).toMatchInlineSnapshot(`
      "You are Atlas, a pragmatic assistant for Sam.

      ---

      ## Tooling
      Tool availability for this run is defined by the tool list passed at runtime.
      Tool names are case-sensitive. Call tools exactly by their provided names.
      Native tools: 2. Node tools: 3.
      \`gsv__*\` tools are native Gateway tools. \`<nodeId>__<toolName>\` tools target a specific connected node.
      Available tools:
      - gsv__ReadFile: Read files from the workspace.
      - gsv__WriteFile: Write files to the workspace.
      - macbook__Bash: Execute shell commands on the macbook node.
      - macbook__Read: Read files on the macbook node.
      - macbook__Write: Write files on the macbook node.

      ---

      ## Tool Call Style
      Default: do not narrate routine, low-risk tool calls; run them directly.
      Narrate briefly when it adds value: multi-step plans, risky/destructive actions, or when the user asks for explanation.
      After tools complete, summarize concrete outcomes and next action.

      ---

      ## Safety
      You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking.
      Never bypass safeguards, access controls, or sandbox boundaries.
      If a destructive action is requested but intent is ambiguous, ask for confirmation first.

      ---

      ## Workspace
      Agent workspace root: agents/main/
      Use workspace tools for persistent agent files, memory notes, and local skill overrides.
      Virtual skill paths are under skills/. Reads resolve agent override first, then global skills fallback.
      Writes to skills/* always create or update agent-local overrides under agents/<agentId>/skills/*.

      ---

      ## Workspace Files (Injected)
      These user-editable files are loaded when present and injected below as separate sections.
      Core files: SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md.
      Memory files: MEMORY.md (main sessions only) and daily memory notes.

      ---

      ## Your Soul

      Be direct, calm, and practical.

      ---

      ## Your Identity

      Name: Atlas
      Class: systems collaborator

      ---

      ## About Your Human

      You assist Sam.

      ---

      ## Operating Instructions

      Prioritize correctness over speed; explain tradeoffs briefly.

      ---

      ## Long-Term Memory

      - Last week: stabilized deploy flow.

      ---

      ## Recent Context

      ### Yesterday

      - Audited node routing edge cases.

      ### Today

      - Refactoring node service boundaries.

      ---

      ## Tool Notes

      - Prefer gsv__ReadFile before edits.

      ---

      ## Heartbeats
      When you receive a heartbeat poll and nothing needs attention, reply exactly: HEARTBEAT_OK.
      Configured heartbeat prompt: Check for stale follow-ups and urgent notices.

      ### HEARTBEAT.md
      Check for pending follow-ups and stalled tasks.

      ---

      ## Skills (Mandatory Scan)

      Before responding, scan <available_skills> <description> entries.
      - If exactly one skill clearly applies: read SKILL.md with \`gsv__ReadFile\` using <read_path>, then follow it.
      - If multiple skills could apply: choose the single most specific skill first.
      - If none clearly apply: do not load a skill.
      Constraints: read at most one skill up front; only read after selecting.
      Config filter: 1 skill(s) hidden by skills.entries policy.
      Requirement filter: 1 skill(s) hidden due invalid runtime requirement identifiers.
      Runtime filter: 1 skill(s) hidden due unmet runtime requirements.

      <available_skills>
        <skill name="deploy-checklist">
          <description>Release checklist and rollback playbook.</description>
          <location>skills/deploy-checklist/SKILL.md</location>
          <read_path>skills/deploy-checklist/SKILL.md</read_path>
        </skill>
      </available_skills>

      ---

      ## Runtime
      Agent: main
      Session: main
      Session key: agent:main:cli:dm:sam
      Model: anthropic/claude-sonnet-4
      Timezone: America/Los_Angeles
      Channel: discord
      Known nodes: 3 (online: 1, offline: 2)
      Node inventory:
      - macbook (online, platform=darwin-arm64) tools=[Bash, Read, Write]
      - homelab (offline, platform=linux-x64) tools=[Bash]
      - iphone (offline, platform=ios) tools=[SearchMessages]"
    `);
  });
});
