/**
 * ai.* syscall handlers.
 *
 * ai.tools — returns available tool schemas + online devices accessible to caller.
 * ai.config — reads model/provider/apiKey from /sys/ (kernel SQLite via ConfigStore).
 *
 * Config resolution order:
 *   /sys/config/ai/* (system defaults) → /sys/users/{uid}/ai/* (user overrides)
 *
 * Runtime reads are explicit SQLite overrides over code defaults.
 */

import type { KernelContext } from "./context";
import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
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
  resolvePackageProfileReference,
  visiblePackageScopesForActor,
} from "./packages";

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

const SYSCALL_TOOLS: Record<string, ToolDefinition> = {
  "fs.read": FS_READ_DEFINITION,
  "fs.write": FS_WRITE_DEFINITION,
  "fs.edit": FS_EDIT_DEFINITION,
  "fs.delete": FS_DELETE_DEFINITION,
  "fs.search": FS_SEARCH_DEFINITION,
  "shell.exec": SHELL_EXEC_DEFINITION,
  "codemode.exec": CODEMODE_EXEC_DEFINITION,
};

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

  const tools: ToolDefinition[] = [];

  for (const [syscall, baseDef] of Object.entries(SYSCALL_TOOLS)) {
    const allowed = capabilities.includes("*") || capabilities.some((cap) => {
      if (cap === syscall) return true;
      const domain = syscall.split(".")[0];
      return cap === `${domain}.*`;
    });
    if (!allowed) continue;

    if (isRoutableSyscall(syscall as SyscallName)) {
      tools.push(intoSyscallTool(baseDef, deviceIds));
    } else {
      tools.push(baseDef);
    }
  }

  return { tools, devices: onlineDevices };
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
