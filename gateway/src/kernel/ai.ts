/**
 * ai.* syscall handlers.
 *
 * ai.tools — returns available tool schemas, online devices, and ready MCP servers accessible to caller.
 * ai.config — reads model/provider/apiKey from /sys/ (kernel SQLite via ConfigStore).
 *
 * Config resolution order:
 *   /sys/config/ai/* (system defaults) → /sys/users/{uid}/ai/* (user overrides)
 *
 * Runtime reads are explicit SQLite overrides over code defaults.
 */

import type { KernelContext } from "./context";
import { getModels, getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import type {
  AiToolsResult,
  AiToolsDevice,
  AiConfigArgs,
  AiConfigResult,
} from "../syscalls/ai";
import {
  isPackageAiContextProfile,
  isSystemAiContextProfile,
} from "../syscalls/ai";
import type { ToolDefinition, SyscallName } from "../syscalls";
import { intoSyscallTool, isRoutableSyscall } from "../syscalls";
import {
  buildCodeModeMcpToolBindings,
  buildCodeModeMcpTypeDeclarations,
  type CodeModeMcpToolSource,
} from "../codemode/mcp";
import {
  resolvePackageProfileReference,
  visiblePackageScopesForActor,
} from "./packages";
import {
  isRemoteSocialAuthority,
  isSyscallToolVisibleForAuthority,
} from "./authority";

import { FS_READ_DEFINITION } from "../syscalls/read";
import { FS_WRITE_DEFINITION } from "../syscalls/write";
import { FS_EDIT_DEFINITION } from "../syscalls/edit";
import { FS_WRITE_DEFINITION as FS_DELETE_DEFINITION } from "../syscalls/delete";
import { FS_SEARCH_DEFINITION } from "../syscalls/search";
import { SHELL_EXEC_DEFINITION } from "../syscalls/shell";
import { CODEMODE_EXEC_DEFINITION } from "../syscalls/codemode";
import {
  isWorkersAiProvider,
  resolveWorkersAiModelContextWindow,
} from "../inference/workers-ai";
import { collectPromptSkillIndex } from "./skills";
import { buildSocialPromptContext } from "./social";

const SYSCALL_TOOLS: Record<string, ToolDefinition> = {
  "fs.read": FS_READ_DEFINITION,
  "fs.write": FS_WRITE_DEFINITION,
  "fs.edit": FS_EDIT_DEFINITION,
  "fs.delete": FS_DELETE_DEFINITION,
  "fs.search": FS_SEARCH_DEFINITION,
  "shell.exec": SHELL_EXEC_DEFINITION,
  "codemode.exec": CODEMODE_EXEC_DEFINITION,
};

const CODEMODE_MCP_TYPE_HINT_MAX_CHARS = 12_000;

type ContextFile = { name: string; text: string };

export async function handleAiTools(
  ctx: KernelContext,
): Promise<AiToolsResult> {
  const identity = ctx.identity!;
  const capabilities = identity.capabilities;
  const uid = identity.process.uid;
  const gids = identity.process.gids;

  const onlineDevices: AiToolsDevice[] = [];
  const deviceIds: string[] = [];

  if (!isRemoteSocialAuthority(ctx.authority)) {
    for (const device of ctx.devices.listForUser(uid, gids)) {
      if (!device.online) continue;
      deviceIds.push(device.device_id);
      onlineDevices.push({
        id: device.device_id,
        implements: device.implements,
        ...(device.description ? { description: device.description } : {}),
        platform: device.platform || undefined,
      });
    }
  }

  const tools: ToolDefinition[] = [];

  for (const [syscall, baseDef] of Object.entries(SYSCALL_TOOLS)) {
    if (!isSyscallToolVisibleForAuthority(ctx.authority, syscall)) {
      continue;
    }
    const allowed = capabilities.includes("*") || capabilities.some((cap) => {
      if (cap === syscall) return true;
      const domain = syscall.split(".")[0];
      return cap === `${domain}.*`;
    });
    if (!allowed) continue;

    if (isRoutableSyscall(syscall as SyscallName)) {
      tools.push(intoSyscallTool(baseDef, deviceIds));
    } else if (syscall === "codemode.exec") {
      tools.push(withCodeModeMcpTypeHints(baseDef, ctx, uid));
    } else {
      tools.push(baseDef);
    }
  }

  return {
    tools,
    devices: onlineDevices,
    mcpServers: listReadyMcpServerNames(ctx, uid),
  };
}

export async function handleAiConfig(
  args: AiConfigArgs,
  ctx: KernelContext,
): Promise<AiConfigResult> {
  const config = ctx.config;
  const uid = ctx.identity?.process.uid ?? 0;
  const requestedProfile = args.profile ?? "task";

  const provider =
    config.get(`users/${uid}/ai/provider`) ??
    config.get("config/ai/provider") ??
    "workers-ai";

  const model =
    config.get(`users/${uid}/ai/model`) ??
    config.get("config/ai/model") ??
    "@cf/nvidia/nemotron-3-120b-a12b";

  const apiKey =
    config.get(`users/${uid}/ai/api_key`) ??
    config.get("config/ai/api_key") ??
    "";

  const reasoning =
    config.get(`users/${uid}/ai/reasoning`) ??
    config.get("config/ai/reasoning") ??
    undefined;

  const maxTokens = parseInt(
    config.get(`users/${uid}/ai/max_tokens`) ??
    config.get("config/ai/max_tokens") ??
    "8192",
    10,
  );
  const contextWindowOverride = parsePositiveInt(
    config.get(`users/${uid}/ai/context_window_tokens`),
  );
  const modelContextWindow = await resolveModelContextWindow(provider, model);
  const configuredContextWindow = parsePositiveInt(
    config.get("config/ai/context_window_tokens"),
  );
  const contextWindowTokens =
    contextWindowOverride ?? modelContextWindow ?? configuredContextWindow ?? null;
  const contextWindowSource = contextWindowOverride !== null
    ? "config"
    : modelContextWindow !== null
      ? "model"
      : configuredContextWindow !== null
        ? "config"
        : "unknown";

  const systemContextFiles = listConfigContextFiles(config, "config/ai/context.d");

  let profile = requestedProfile;
  let profileContextFiles: ContextFile[] = [];
  let profileApprovalPolicy: string | null = null;

  if (isPackageAiContextProfile(requestedProfile)) {
    const resolved = resolvePackageProfileReference(
      requestedProfile,
      ctx.packages,
      visiblePackageScopesForActor(ctx.identity?.process),
    );
    if (!resolved) {
      throw new Error(`Unknown package profile: ${requestedProfile}`);
    }
    profileContextFiles = resolved.packageProfile.contextFiles
      .filter((file) => file.text.trim().length > 0)
      .sort((left, right) => left.name.localeCompare(right.name));
    profileApprovalPolicy = resolved.packageProfile.approvalPolicy ?? null;
  } else {
    profile = isSystemAiContextProfile(requestedProfile) ? requestedProfile : "task";
    profileContextFiles = listConfigContextFiles(config, `config/ai/profile/${profile}/context.d`);
    profileApprovalPolicy =
      config.get(`config/ai/profile/${profile}/tools/approval`) ??
      null;
  }

  const maxContextBytes = parseInt(
    config.get(`users/${uid}/ai/max_context_bytes`) ??
    config.get("config/ai/max_context_bytes") ??
    "32768",
    10,
  );
  const skillIndex = await collectPromptSkillIndex(ctx, requestedProfile).catch((error) => {
    console.warn(
      `[Prompt] failed to collect skills.d index: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  });

  return {
    profile,
    provider,
    model,
    apiKey,
    reasoning,
    maxTokens,
    contextWindowTokens,
    contextWindowSource,
    systemContextFiles,
    profileContextFiles,
    skillIndex,
    socialContext: buildSocialPromptContext(ctx),
    profileApprovalPolicy,
    maxContextBytes,
  };
}

function listConfigContextFiles(config: KernelContext["config"], prefix: string): ContextFile[] {
  return config
    .list(prefix)
    .map(({ key, value }) => ({
      name: key.slice(`${prefix}/`.length),
      text: value,
    }))
    .filter((file) => file.name.endsWith(".md") && file.text.trim().length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function withCodeModeMcpTypeHints(
  baseDef: ToolDefinition,
  ctx: KernelContext,
  uid: number,
): ToolDefinition {
  const bindings = buildCodeModeMcpToolBindings(listReadyMcpToolSources(ctx, uid));
  const typeDeclarations = buildCodeModeMcpTypeDeclarations(bindings);
  if (!typeDeclarations) {
    return baseDef;
  }

  return {
    ...baseDef,
    description: `${baseDef.description}\n\nConnected MCP tools are available as typed CodeMode globals:\n\n\`\`\`ts\n${truncateMcpTypeHints(typeDeclarations)}\n\`\`\``,
  };
}

function listReadyMcpToolSources(
  ctx: KernelContext,
  uid: number,
): CodeModeMcpToolSource[] {
  return ctx.mcpServers.list(uid).flatMap((record) => {
    const connection = ctx.mcp.mcpConnections[record.serverId] as {
      connectionState?: unknown;
    } | undefined;
    if (connection?.connectionState !== "ready") {
      return [];
    }

    const tools = ctx.mcp.listTools({ serverId: record.serverId }) as unknown[];
    return [{
      serverId: record.serverId,
      serverName: record.name,
      state: "ready",
      tools: tools
        .filter(isRecord)
        .map((tool) => ({
          name: typeof tool.name === "string" ? tool.name : "tool",
          description: typeof tool.description === "string" ? tool.description : null,
          inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : null,
          outputSchema: isRecord(tool.outputSchema) ? tool.outputSchema : null,
        })),
    }];
  });
}

function listReadyMcpServerNames(ctx: KernelContext, uid: number): string[] {
  const names = new Set<string>();
  for (const record of ctx.mcpServers.list(uid)) {
    const connection = ctx.mcp.mcpConnections[record.serverId] as {
      connectionState?: unknown;
    } | undefined;
    if (connection?.connectionState === "ready") {
      names.add(record.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function truncateMcpTypeHints(typeDeclarations: string): string {
  if (typeDeclarations.length <= CODEMODE_MCP_TYPE_HINT_MAX_CHARS) {
    return typeDeclarations;
  }
  const trimmed = typeDeclarations
    .slice(0, CODEMODE_MCP_TYPE_HINT_MAX_CHARS)
    .replace(/\n[^\n]*$/, "");
  return `${trimmed}\n// ... additional MCP tool types omitted; inspect mcpTools at runtime for full metadata.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function resolveModelContextWindow(provider: string, model: string): Promise<number | null> {
  if (isWorkersAiProvider(provider)) {
    const workersAiContextWindow = await resolveWorkersAiModelContextWindow(model);
    if (workersAiContextWindow !== null) {
      return workersAiContextWindow;
    }
  }

  if (!isKnownProvider(provider)) {
    return null;
  }
  const resolved = getModels(provider).find((candidate) => candidate.id === model);
  return Number.isSafeInteger(resolved?.contextWindow) && resolved!.contextWindow > 0
    ? resolved!.contextWindow
    : null;
}

function isKnownProvider(provider: string): provider is KnownProvider {
  return getProviders().includes(provider as KnownProvider);
}
