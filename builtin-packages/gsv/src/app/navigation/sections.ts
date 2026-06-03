import type { GsvGroup, GsvSection, GsvSectionId } from "./types";

export const GROUPS: GsvGroup[] = [
  {
    id: "overview",
    label: "Overview",
    shortLabel: "Overview",
    sections: ["overview"],
  },
  {
    id: "agents",
    label: "Agents",
    shortLabel: "Agents",
    sections: ["agents"],
  },
  {
    id: "operations",
    label: "Operations",
    shortLabel: "Ops",
    sections: ["runtime", "devices"],
  },
  {
    id: "extensions",
    label: "Extensions",
    shortLabel: "Extend",
    sections: ["packages", "sources", "integrations"],
  },
  {
    id: "administration",
    label: "Administration",
    shortLabel: "Admin",
    sections: ["access", "settings"],
  },
];

export const SECTIONS: GsvSection[] = [
  {
    id: "overview",
    groupId: "overview",
    label: "Overview",
    shortLabel: "Overview",
    title: "Attention",
    summary: "System state that needs an operator decision.",
    statusLabel: "Console",
    tone: "accent",
    localItems: [
      {
        label: "Review queue",
        description: "Trust decisions, disconnected surfaces, unhealthy nodes, and runtime issues.",
        meta: "Attention inbox",
        tone: "warning",
      },
      {
        label: "Recent operations",
        description: "Last touched packages, targets, processes, and access changes.",
        meta: "Activity",
      },
      {
        label: "System posture",
        description: "A compact read on readiness across runtime, targets, extensions, and administration.",
        meta: "Status",
        tone: "good",
      },
    ],
    handoffs: [
      {
        label: "Review packages",
        description: "Stay in GSV to handle package trust decisions and updates.",
        sectionId: "packages",
      },
      {
        label: "Open Targets",
        description: "Inspect target health, provisioning, and access in GSV.",
        sectionId: "devices",
      },
    ],
  },
  {
    id: "agents",
    groupId: "agents",
    label: "Agents",
    shortLabel: "Agents",
    title: "Agents",
    summary: "Manage agent accounts, their context, and runtime behavior.",
    statusLabel: "Agents",
    tone: "accent",
    localItems: [
      {
        label: "Your agents",
        description: "Your personal agent and any custom agents you can run.",
        meta: "Accounts",
      },
      {
        label: "Persona and context",
        description: "Edit the markdown context layered into each agent's prompt.",
        meta: "Context",
      },
      {
        label: "Behavior",
        description: "Per-agent model override and tool approval policy.",
        meta: "Policy",
      },
    ],
    handoffs: [],
  },
  {
    id: "runtime",
    groupId: "operations",
    label: "Runtime",
    shortLabel: "Runtime",
    title: "Runtime",
    summary: "Inspect and control running agent processes.",
    statusLabel: "Operations",
    tone: "neutral",
    localItems: [
      {
        label: "Process list",
        description: "Search by pid, label, profile, owner, or path.",
        meta: "Queue",
      },
      {
        label: "Process detail",
        description: "Open the conversation, inspect metadata, or stop the process.",
        meta: "Inspector",
      },
      {
        label: "Runtime anomalies",
        description: "Long-running, stale, failed, or attention-worthy process state.",
        meta: "Attention",
        tone: "warning",
      },
    ],
    handoffs: [
      {
        label: "Open Runtime",
        description: "Inspect and control running processes in GSV.",
        sectionId: "runtime",
      },
    ],
  },
  {
    id: "devices",
    groupId: "operations",
    label: "Targets",
    shortLabel: "Targets",
    title: "Targets",
    summary: "Manage execution targets, health, capabilities, and native node provisioning.",
    statusLabel: "Operations",
    tone: "good",
    localItems: [
      {
        label: "Target list",
        description: "Native devices, browser sessions, adapters, status, owner, and routing readiness.",
        meta: "List/detail",
      },
      {
        label: "Provisioning",
        description: "Issue node tokens and guide first connection for a new target.",
        meta: "Flow",
      },
      {
        label: "Access and health",
        description: "Review native node tokens, capabilities, and health evidence.",
        meta: "Inspector",
      },
    ],
    handoffs: [
      {
        label: "Open Targets",
        description: "Stay in GSV to manage execution targets.",
        sectionId: "devices",
      },
      {
        label: "Open Shell",
        description: "Open the terminal companion app.",
        target: "shell",
      },
    ],
  },
  {
    id: "packages",
    groupId: "extensions",
    label: "Packages",
    shortLabel: "Packages",
    title: "Packages",
    summary: "Review, trust, update, install, and inspect packages.",
    statusLabel: "Extensions",
    tone: "warning",
    localItems: [
      {
        label: "Trust review",
        description: "Approve or reject packages before enablement.",
        meta: "Queue",
        tone: "warning",
      },
      {
        label: "Inventory and updates",
        description: "See installed packages, available updates, and enabled state.",
        meta: "List/detail",
      },
      {
        label: "Source relationship",
        description: "See package source posture and open the repository browser when deeper inspection is needed.",
        meta: "Source",
      },
    ],
    handoffs: [],
  },
  {
    id: "sources",
    groupId: "extensions",
    label: "Sources",
    shortLabel: "Sources",
    title: "Sources",
    summary: "Browse visible ripgit repositories, source history, files, and diffs.",
    statusLabel: "Extensions",
    tone: "good",
    localItems: [
      {
        label: "Repository browser",
        description: "Open any visible ripgit repository, branch, folder, or file.",
        meta: "Code",
      },
      {
        label: "History and diffs",
        description: "Review commits and inspect source changes without leaving GSV.",
        meta: "History",
      },
      {
        label: "Repository operations",
        description: "Create repositories, pull upstream, and manage public visibility when allowed.",
        meta: "Actions",
      },
    ],
    handoffs: [],
  },
  {
    id: "integrations",
    groupId: "extensions",
    label: "Integrations",
    shortLabel: "Integrations",
    title: "Integrations",
    summary: "Connect external message surfaces and tool servers.",
    statusLabel: "Extensions",
    tone: "accent",
    localItems: [
      {
        label: "Message adapters",
        description: "WhatsApp, Discord, and future account-backed conversation surfaces.",
        meta: "Accounts",
      },
      {
        label: "MCP servers",
        description: "Tool servers, transport health, and available tools.",
        meta: "Tools",
      },
      {
        label: "Connection health",
        description: "Authenticated, connected, unhealthy, or attention-required integrations.",
        meta: "Status",
        tone: "warning",
      },
    ],
    handoffs: [
      {
        label: "Open Message adapters",
        description: "Stay in GSV to manage WhatsApp and Discord accounts.",
        sectionId: "integrations",
      },
      {
        label: "Manage MCP servers",
        description: "Stay in GSV to review tool server health and available tools.",
        sectionId: "integrations",
      },
    ],
  },
  {
    id: "access",
    groupId: "administration",
    label: "Access",
    shortLabel: "Access",
    title: "Access",
    summary: "Manage tokens, identity links, and authorization posture.",
    statusLabel: "Administration",
    tone: "danger",
    localItems: [
      {
        label: "Tokens",
        description: "Create, review, and revoke API or user access tokens.",
        meta: "Credentials",
      },
      {
        label: "Identity links",
        description: "Connect or disconnect external identities from GSV users.",
        meta: "Accounts",
      },
      {
        label: "Permission state",
        description: "Show what is editable for the current viewer before actions run.",
        meta: "Policy",
      },
    ],
    handoffs: [],
  },
  {
    id: "settings",
    groupId: "administration",
    label: "Settings",
    shortLabel: "Settings",
    title: "Settings",
    summary: "Curated runtime configuration with Advanced as an escape hatch.",
    statusLabel: "Administration",
    tone: "neutral",
    localItems: [
      {
        label: "AI defaults",
        description: "Model/provider defaults, personal overrides, and prompt budgets.",
        meta: "Config",
      },
      {
        label: "Runtime behavior",
        description: "Process limits, shell defaults, automation, and server settings.",
        meta: "Config",
      },
      {
        label: "Advanced",
        description: "Raw or unmodeled settings for debugging and recovery.",
        meta: "Escape hatch",
      },
    ],
    handoffs: [],
  },
];

export function findSection(sectionId: GsvSectionId): GsvSection {
  return SECTIONS.find((section) => section.id === sectionId) ?? SECTIONS[0];
}

export function sectionExists(value: string): value is GsvSectionId {
  return SECTIONS.some((section) => section.id === value);
}
