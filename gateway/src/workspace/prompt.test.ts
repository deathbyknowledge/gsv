import { describe, expect, it } from "vitest";
import { buildSystemPromptFromWorkspace } from "./prompt";
import type { AgentWorkspace, WorkspaceFile } from "./loader";
import type { RuntimeNodeInventory, ToolDefinition } from "../protocol/tools";

function file(path: string, content: string): WorkspaceFile {
  return { path, content, exists: true };
}

describe("buildSystemPromptFromWorkspace", () => {
  it("adds a core scaffold even when base prompt is missing", () => {
    const workspace: AgentWorkspace = {
      agentId: "main",
    };

    const prompt = buildSystemPromptFromWorkspace(undefined, workspace);

    expect(prompt).toContain("You are a helpful AI assistant running inside GSV.");
    expect(prompt).toContain("## Tooling");
    expect(prompt).toContain("## Tool Call Style");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Workspace Files (Injected)");
  });

  it("keeps safety/tooling scaffold during bootstrap commissioning", () => {
    const workspace: AgentWorkspace = {
      agentId: "main",
      bootstrap: file("agents/main/BOOTSTRAP.md", "Commissioning instructions."),
      soul: file("agents/main/SOUL.md", "Soul defaults."),
    };

    const prompt = buildSystemPromptFromWorkspace("Base prompt", workspace);

    expect(prompt).toContain("Base prompt");
    expect(prompt).toContain("## Tooling");
    expect(prompt).toContain("## Tool Call Style");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## COMMISSIONING CEREMONY (First Run)");
    expect(prompt).toContain("Commissioning instructions.");
  });

  it("uses gsv read tool naming with canonical skills read paths", () => {
    const tools: ToolDefinition[] = [
      {
        name: "gsv__ReadFile",
        description: "Read files from workspace",
        inputSchema: {
          type: "object",
        },
      },
    ];

    const workspace: AgentWorkspace = {
      agentId: "main",
      skills: [
        {
          name: "demo",
          description: "Demo skill",
          location: "agents/main/skills/demo/SKILL.md",
        },
        {
          name: "global",
          description: "Global skill",
          location: "skills/global/SKILL.md",
        },
      ],
    };

    const prompt = buildSystemPromptFromWorkspace("Base", workspace, { tools });

    expect(prompt).toContain("## Skills (Mandatory Scan)");
    expect(prompt).toContain("gsv__ReadFile");
    expect(prompt).toContain("<read_path>skills/demo/SKILL.md</read_path>");
    expect(prompt).toContain("<read_path>skills/global/SKILL.md</read_path>");
  });

  it("filters skills by runtime capability requirements", () => {
    const tools: ToolDefinition[] = [
      {
        name: "gsv__ReadFile",
        description: "Read files from workspace",
        inputSchema: { type: "object" },
      },
    ];

    const workspace: AgentWorkspace = {
      agentId: "main",
      skills: [
        {
          name: "exec-skill",
          description: "Needs execution shell",
          location: "skills/exec-skill/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                hostRoles: ["execution"],
                capabilities: ["shell.exec"],
              },
            },
          },
        },
        {
          name: "ios-skill",
          description: "Needs specialized search",
          location: "skills/ios-skill/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                hostRoles: ["specialized"],
                capabilities: ["text.search"],
              },
            },
          },
        },
      ],
    };

    const prompt = buildSystemPromptFromWorkspace("Base", workspace, {
      tools,
      runtime: {
        agentId: "main",
        isMainSession: true,
        nodes: {
          executionHostId: "exec-1",
          specializedHostIds: [],
          hosts: [
            {
              nodeId: "exec-1",
              hostRole: "execution",
              hostCapabilities: [
                "filesystem.list",
                "filesystem.read",
                "filesystem.write",
                "shell.exec",
              ],
              toolCapabilities: {},
              tools: ["Bash"],
            },
          ],
        },
      },
    });

    expect(prompt).toContain('<skill name="exec-skill">');
    expect(prompt).not.toContain('<skill name="ios-skill">');
    expect(prompt).toContain(
      "Runtime filter: 1 skill(s) hidden due unmet runtime capability requirements.",
    );
  });

  it("filters skills by config entries policy", () => {
    const tools: ToolDefinition[] = [
      {
        name: "gsv__ReadFile",
        description: "Read files from workspace",
        inputSchema: { type: "object" },
      },
    ];

    const workspace: AgentWorkspace = {
      agentId: "main",
      skills: [
        {
          name: "exec-skill",
          description: "Execution skill",
          location: "skills/exec-skill/SKILL.md",
        },
        {
          name: "ios-skill",
          description: "iOS skill",
          location: "skills/ios-skill/SKILL.md",
        },
      ],
    };

    const prompt = buildSystemPromptFromWorkspace("Base", workspace, {
      tools,
      skillEntries: {
        "ios-skill": { enabled: false },
      },
    });

    expect(prompt).toContain('<skill name="exec-skill">');
    expect(prompt).not.toContain('<skill name="ios-skill">');
    expect(prompt).toContain(
      "Config filter: 1 skill(s) hidden by skills.entries policy.",
    );
  });

  it("applies config requirement overrides for skill eligibility", () => {
    const tools: ToolDefinition[] = [
      {
        name: "gsv__ReadFile",
        description: "Read files from workspace",
        inputSchema: { type: "object" },
      },
    ];

    const workspace: AgentWorkspace = {
      agentId: "main",
      skills: [
        {
          name: "search-skill",
          description: "Originally requires specialized host",
          location: "skills/search-skill/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                hostRoles: ["specialized"],
                capabilities: ["text.search"],
              },
            },
          },
        },
      ],
    };

    const prompt = buildSystemPromptFromWorkspace("Base", workspace, {
      tools,
      skillEntries: {
        "search-skill": {
          requires: {
            hostRoles: ["execution"],
            capabilities: ["shell.exec"],
          },
        },
      },
      runtime: {
        agentId: "main",
        isMainSession: true,
        nodes: {
          executionHostId: "exec-1",
          specializedHostIds: [],
          hosts: [
            {
              nodeId: "exec-1",
              hostRole: "execution",
              hostCapabilities: [
                "filesystem.list",
                "filesystem.read",
                "filesystem.write",
                "shell.exec",
              ],
              toolCapabilities: {},
              tools: ["Bash"],
            },
          ],
        },
      },
    });

    expect(prompt).toContain('<skill name="search-skill">');
    expect(prompt).not.toContain("Runtime filter:");
  });

  it("fails closed for invalid frontmatter requirement identifiers", () => {
    const tools: ToolDefinition[] = [
      {
        name: "gsv__ReadFile",
        description: "Read files from workspace",
        inputSchema: { type: "object" },
      },
    ];

    const workspace: AgentWorkspace = {
      agentId: "main",
      skills: [
        {
          name: "invalid-skill",
          description: "Has typo in capability id",
          location: "skills/invalid-skill/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                capabilities: ["shell.exe"],
              },
            },
          },
        },
        {
          name: "safe-skill",
          description: "No requirements",
          location: "skills/safe-skill/SKILL.md",
        },
      ],
    };

    const prompt = buildSystemPromptFromWorkspace("Base", workspace, {
      tools,
      runtime: {
        agentId: "main",
        isMainSession: true,
        nodes: {
          executionHostId: "exec-1",
          specializedHostIds: [],
          hosts: [
            {
              nodeId: "exec-1",
              hostRole: "execution",
              hostCapabilities: [
                "filesystem.list",
                "filesystem.read",
                "filesystem.write",
                "shell.exec",
              ],
              toolCapabilities: {},
              tools: ["Bash"],
            },
          ],
        },
      },
    });

    expect(prompt).not.toContain('<skill name="invalid-skill">');
    expect(prompt).toContain('<skill name="safe-skill">');
    expect(prompt).toContain(
      "Requirement filter: 1 skill(s) hidden due invalid runtime requirement identifiers.",
    );
  });

  it("fails closed for invalid config requirement overrides", () => {
    const tools: ToolDefinition[] = [
      {
        name: "gsv__ReadFile",
        description: "Read files from workspace",
        inputSchema: { type: "object" },
      },
    ];

    const workspace: AgentWorkspace = {
      agentId: "main",
      skills: [
        {
          name: "search-skill",
          description: "Valid by frontmatter",
          location: "skills/search-skill/SKILL.md",
          metadata: {
            gsv: {
              requires: {
                hostRoles: ["execution"],
                capabilities: ["shell.exec"],
              },
            },
          },
        },
        {
          name: "safe-skill",
          description: "No requirements",
          location: "skills/safe-skill/SKILL.md",
        },
      ],
    };

    const prompt = buildSystemPromptFromWorkspace("Base", workspace, {
      tools,
      skillEntries: {
        "search-skill": {
          requires: {
            capabilities: ["shell.exe"],
          },
        },
      },
      runtime: {
        agentId: "main",
        isMainSession: true,
        nodes: {
          executionHostId: "exec-1",
          specializedHostIds: [],
          hosts: [
            {
              nodeId: "exec-1",
              hostRole: "execution",
              hostCapabilities: [
                "filesystem.list",
                "filesystem.read",
                "filesystem.write",
                "shell.exec",
              ],
              toolCapabilities: {},
              tools: ["Bash"],
            },
          ],
        },
      },
    });

    expect(prompt).not.toContain('<skill name="search-skill">');
    expect(prompt).toContain('<skill name="safe-skill">');
    expect(prompt).toContain(
      "Requirement filter: 1 skill(s) hidden due invalid runtime requirement identifiers.",
    );
  });

  it("includes heartbeat guidance from config and HEARTBEAT.md", () => {
    const nodes: RuntimeNodeInventory = {
      executionHostId: "exec-node-1",
      specializedHostIds: ["iphone-node"],
      hosts: [
        {
          nodeId: "exec-node-1",
          hostRole: "execution",
          hostCapabilities: [
            "filesystem.list",
            "filesystem.read",
            "filesystem.write",
            "shell.exec",
          ],
          toolCapabilities: {
            Bash: ["shell.exec"],
          },
          tools: ["Bash", "Read", "Write"],
        },
        {
          nodeId: "exec-node-2",
          hostRole: "execution",
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
        },
        {
          nodeId: "iphone-node",
          hostRole: "specialized",
          hostCapabilities: ["text.search"],
          toolCapabilities: {
            SearchMessages: ["text.search"],
          },
          tools: ["SearchMessages"],
        },
      ],
    };

    const workspace: AgentWorkspace = {
      agentId: "main",
      heartbeat: file(
        "agents/main/HEARTBEAT.md",
        "# Checks\n\nLook for missed follow-ups.",
      ),
    };

    const prompt = buildSystemPromptFromWorkspace("Base", workspace, {
      heartbeatPrompt: "Heartbeat poll",
      runtime: {
        agentId: "main",
        sessionKey: "agent:main:cli:dm:me",
        isMainSession: true,
        model: { provider: "anthropic", id: "claude" },
        nodes,
      },
    });

    expect(prompt).toContain("## Heartbeats");
    expect(prompt).toContain("Configured heartbeat prompt: Heartbeat poll");
    expect(prompt).toContain("### HEARTBEAT.md");
    expect(prompt).toContain("Look for missed follow-ups.");
    expect(prompt).toContain("## Runtime");
    expect(prompt).toContain("Agent: main");
    expect(prompt).toContain("Session: main");
    expect(prompt).toContain("Model: anthropic/claude");
    expect(prompt).toContain("Primary execution host: exec-node-1");
    expect(prompt).toContain("Execution hosts: exec-node-1, exec-node-2");
    expect(prompt).toContain("Specialized hosts: iphone-node");
    expect(prompt).toContain(
      "Capabilities are internal routing metadata. Do not call capability IDs as tools; call only listed tool names.",
    );
    expect(prompt).toContain(
      "- exec-node-1 (execution) capabilities=[filesystem.list, filesystem.read, filesystem.write, shell.exec] tools=[Bash, Read, Write]",
    );
  });
});
