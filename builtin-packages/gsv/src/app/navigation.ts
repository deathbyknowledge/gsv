import type { AttentionItem, GsvGroup, GsvSection, GsvSectionId } from "./types";

export const GROUPS: GsvGroup[] = [
  {
    id: "overview",
    label: "Overview",
    shortLabel: "Overview",
    sections: ["overview"],
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
    sections: ["packages", "integrations"],
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
        description: "Last touched packages, devices, processes, and access changes.",
        meta: "Activity",
      },
      {
        label: "System posture",
        description: "A compact read on readiness across runtime, devices, extensions, and administration.",
        meta: "Status",
        tone: "good",
      },
    ],
    handoffs: [
      {
        label: "Open current Packages",
        description: "Use the existing package app while the Packages section migrates.",
        target: "packages",
        route: "/apps/packages?view=review",
      },
      {
        label: "Open current Devices",
        description: "Use the existing fleet app while the Devices section migrates.",
        target: "devices",
      },
    ],
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
        description: "Search by pid, label, profile, owner, or workspace.",
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
        label: "Open current Processes",
        description: "Launch the existing process inspector.",
        target: "processes",
      },
    ],
  },
  {
    id: "devices",
    groupId: "operations",
    label: "Devices",
    shortLabel: "Devices",
    title: "Devices",
    summary: "Manage execution targets, node health, capabilities, and provisioning.",
    statusLabel: "Operations",
    tone: "good",
    localItems: [
      {
        label: "Fleet",
        description: "Online/offline state, owner, platform, last seen, and routing readiness.",
        meta: "List/detail",
      },
      {
        label: "Provisioning",
        description: "Issue node tokens and guide first connection for a new target.",
        meta: "Flow",
      },
      {
        label: "Access and health",
        description: "Review device tokens, capabilities, and health evidence.",
        meta: "Inspector",
      },
    ],
    handoffs: [
      {
        label: "Open current Devices",
        description: "Launch the existing fleet manager.",
        target: "devices",
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
        label: "Sources and remotes",
        description: "Manage package sources, public catalog entries, and source browsing.",
        meta: "Source",
      },
    ],
    handoffs: [
      {
        label: "Open current Packages",
        description: "Launch the existing package lifecycle app.",
        target: "packages",
      },
    ],
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
        label: "Open current Adapters",
        description: "Launch the existing adapter account manager.",
        target: "adapters",
      },
      {
        label: "Open MCP settings",
        description: "Launch Control on the MCP section.",
        target: "control",
        route: "/apps/control?tab=mcp",
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
    handoffs: [
      {
        label: "Open current Access",
        description: "Launch Control on the access section.",
        target: "control",
        route: "/apps/control?tab=access",
      },
    ],
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
        label: "AI and profiles",
        description: "Model/provider defaults, profile policy, and runtime prompt settings.",
        meta: "Config",
      },
      {
        label: "Runtime behavior",
        description: "Process limits, shell defaults, automation, server settings, and workspace policy.",
        meta: "Config",
      },
      {
        label: "Advanced",
        description: "Raw or unmodeled settings for debugging and recovery.",
        meta: "Escape hatch",
      },
    ],
    handoffs: [
      {
        label: "Open current Settings",
        description: "Launch Control on the configuration section.",
        target: "control",
        route: "/apps/control?tab=config",
      },
    ],
  },
];

export const ATTENTION_ITEMS: AttentionItem[] = [
  {
    label: "Package trust decisions",
    description: "Review packages before they become active system code.",
    sectionId: "packages",
    tone: "warning",
  },
  {
    label: "Fleet readiness",
    description: "Check offline nodes, health, capabilities, and provisioning.",
    sectionId: "devices",
    tone: "good",
  },
  {
    label: "External connections",
    description: "Inspect adapters and MCP servers from one integration surface.",
    sectionId: "integrations",
    tone: "accent",
  },
  {
    label: "Credentials and identity",
    description: "Review tokens and linked external identities.",
    sectionId: "access",
    tone: "danger",
  },
];

export function findSection(sectionId: GsvSectionId): GsvSection {
  return SECTIONS.find((section) => section.id === sectionId) ?? SECTIONS[0];
}

export function sectionExists(value: string): value is GsvSectionId {
  return SECTIONS.some((section) => section.id === value);
}
