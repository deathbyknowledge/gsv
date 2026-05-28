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
  AiSpeechCreateArgs,
  AiSpeechCreateResult,
  AiTranscriptionCreateArgs,
  AiTranscriptionCreateResult,
  ContextFile,
} from "../syscalls/ai";
import {
  isPackageAiContextProfile,
  isSystemAiContextProfile,
  isUserAiContextProfile,
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
import { resolveUserAiProfile } from "./user-profiles";

import { FS_READ_DEFINITION } from "../syscalls/read";
import { FS_WRITE_DEFINITION } from "../syscalls/write";
import { FS_EDIT_DEFINITION } from "../syscalls/edit";
import { FS_DELETE_DEFINITION } from "../syscalls/delete";
import { FS_SEARCH_DEFINITION } from "../syscalls/search";
import { SHELL_EXEC_DEFINITION } from "../syscalls/shell";
import { CODEMODE_EXEC_DEFINITION } from "../syscalls/codemode";
import {
  isWorkersAiProvider,
  resolveWorkersAiModelContextWindow,
} from "../inference/workers-ai";
import {
  DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES,
  normalizeBase64Data,
  transcribeAudioWithWorkersAi,
} from "../inference/transcription";
import {
  DEFAULT_AUDIO_SPEECH_ENCODING,
  DEFAULT_AUDIO_SPEECH_MODEL,
  DEFAULT_AUDIO_SPEECH_SPEAKER,
  DEFAULT_AUDIO_SPEECH_TIMEOUT_MS,
  DEFAULT_MAX_AUDIO_SPEECH_CHARS,
  synthesizeSpeechWithWorkersAi,
} from "../inference/speech";
import {
  normalizeSpeechText,
  normalizeSpeechTextFormat,
} from "@gsv/protocol/speech-text";
import { collectPromptSkillIndex } from "./skills";
import { listVisibleTargets, targetToAiDevice } from "./targets";

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

const PERSONAL_PROFILE_ALIAS = "personal";
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const DEFAULT_GENERATION_STREAMING = "auto";

export async function handleAiTools(
  ctx: KernelContext,
): Promise<AiToolsResult> {
  const identity = ctx.identity!;
  const capabilities = identity.capabilities;
  const uid = identity.process.uid;

  const onlineDevices: AiToolsDevice[] = [];
  const deviceIds: string[] = [];

  for (const target of listVisibleTargets(ctx)) {
    deviceIds.push(target.targetId);
    onlineDevices.push(targetToAiDevice(target));
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
  const requestedProfile = args.profile === PERSONAL_PROFILE_ALIAS ? "init" : args.profile ?? "task";

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
  } else if (isSystemAiContextProfile(requestedProfile)) {
    profile = requestedProfile;
    profileContextFiles = listConfigContextFiles(config, `config/ai/profile/${profile}/context.d`);
    profileApprovalPolicy =
      config.get(`config/ai/profile/${profile}/tools/approval`) ??
      null;
  } else if (isUserAiContextProfile(requestedProfile)) {
    const userProfile = await resolveUserAiProfile(ctx, requestedProfile);
    if (!userProfile) {
      throw new Error(`Unknown user profile: ${requestedProfile}`);
    }
    profile = requestedProfile;
    profileContextFiles = [
      ...listConfigContextFiles(config, "config/ai/profile/task/context.d"),
      ...userProfile.contextFiles.map((file) => ({
        name: `${requestedProfile}/${file.name}`,
        text: file.text,
      })),
    ];
    profileApprovalPolicy =
      userProfile.approvalPolicy ??
      config.get("config/ai/profile/task/tools/approval") ??
      null;
  } else {
    profile = "task";
    profileContextFiles = listConfigContextFiles(config, "config/ai/profile/task/context.d");
    profileApprovalPolicy =
      config.get("config/ai/profile/task/tools/approval") ??
      null;
  }

  const maxContextBytes = parseInt(
    config.get(`users/${uid}/ai/max_context_bytes`) ??
    config.get("config/ai/max_context_bytes") ??
    "32768",
    10,
  );
  const generationTimeoutMs = parsePositiveInt(
    config.get(`users/${uid}/ai/generation/timeout_ms`),
  ) ?? parsePositiveInt(
    config.get("config/ai/generation/timeout_ms"),
  ) ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationStreaming = normalizeGenerationStreaming(
    config.get("config/ai/generation/streaming"),
  );
  const skillIndex = await collectPromptSkillIndex(ctx, profile).catch((error) => {
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
    generationTimeoutMs,
    generationStreaming,
  };
}

export async function handleAiTranscriptionCreate(
  args: AiTranscriptionCreateArgs,
  ctx: KernelContext,
): Promise<AiTranscriptionCreateResult> {
  const uid = ctx.identity?.process.uid ?? 0;
  const audio = args.audio;
  if (!audio || typeof audio !== "object") {
    throw new Error("audio is required");
  }
  if (typeof audio.data !== "string" || audio.data.trim().length === 0) {
    throw new Error("audio.data is required");
  }
  if (typeof audio.mimeType !== "string" || !audio.mimeType.trim().toLowerCase().startsWith("audio/")) {
    throw new Error("audio.mimeType must be an audio MIME type");
  }

  const base64 = normalizeBase64Data(audio.data.trim());
  const byteLength = base64DecodedLength(base64);
  const maxBytes = parsePositiveInt(
    ctx.config.get(`users/${uid}/ai/transcription/max_bytes`),
  ) ?? parsePositiveInt(
    ctx.config.get("config/ai/transcription/max_bytes"),
  ) ?? DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES;
  if (byteLength <= 0) {
    throw new Error("audio.data is empty");
  }
  if (byteLength > maxBytes) {
    throw new Error(`audio.data exceeds transcription limit (${maxBytes} bytes)`);
  }

  const model =
    ctx.config.get(`users/${uid}/ai/transcription/model`) ??
    ctx.config.get("config/ai/transcription/model") ??
    DEFAULT_AUDIO_TRANSCRIPTION_MODEL;
  const mode = args.mode === "translate" ? "translate" : "transcribe";
  const result = await transcribeAudioWithWorkersAi(ctx.env.AI, {
    data: base64,
    model,
    mode,
    language: normalizeOptionalString(args.language),
    prompt: normalizeOptionalString(args.prompt),
    vadFilter: true,
    conditionOnPreviousText: false,
  });
  if (!result) {
    throw new Error("Transcription unavailable");
  }

  return result;
}

export async function handleAiSpeechCreate(
  args: AiSpeechCreateArgs,
  ctx: KernelContext,
): Promise<AiSpeechCreateResult> {
  const input = args && typeof args === "object" ? args : ({} as AiSpeechCreateArgs);
  const uid = ctx.identity?.process.uid ?? 0;
  const rawText = normalizeOptionalString(input.text);
  if (!rawText) {
    throw new Error("text is required");
  }
  const text = normalizeSpeechText(rawText, normalizeSpeechTextFormat(input.textFormat));
  if (!text) {
    return {
      audio: {
        data: "",
        mimeType: "",
        size: 0,
      },
      provider: "none",
      model: "none",
      skipped: true,
    };
  }

  const maxChars = parsePositiveInt(
    ctx.config.get(`users/${uid}/ai/speech/max_chars`),
  ) ?? parsePositiveInt(
    ctx.config.get("config/ai/speech/max_chars"),
  ) ?? DEFAULT_MAX_AUDIO_SPEECH_CHARS;
  if (text.length > maxChars) {
    throw new Error(`text exceeds speech limit (${maxChars} chars)`);
  }

  const model = normalizeOptionalString(input.model)
    ?? normalizeOptionalString(ctx.config.get(`users/${uid}/ai/speech/model`))
    ?? normalizeOptionalString(ctx.config.get("config/ai/speech/model"))
    ?? DEFAULT_AUDIO_SPEECH_MODEL;
  const voice = normalizeOptionalString(input.voice)
    ?? normalizeOptionalString(ctx.config.get(`users/${uid}/ai/speech/speaker`))
    ?? normalizeOptionalString(ctx.config.get("config/ai/speech/speaker"))
    ?? DEFAULT_AUDIO_SPEECH_SPEAKER;
  const encoding = normalizeOptionalString(input.encoding)
    ?? normalizeOptionalString(ctx.config.get(`users/${uid}/ai/speech/encoding`))
    ?? normalizeOptionalString(ctx.config.get("config/ai/speech/encoding"))
    ?? DEFAULT_AUDIO_SPEECH_ENCODING;
  const timeoutMs = parsePositiveInt(
    ctx.config.get(`users/${uid}/ai/speech/timeout_ms`),
  ) ?? parsePositiveInt(
    ctx.config.get("config/ai/speech/timeout_ms"),
  ) ?? DEFAULT_AUDIO_SPEECH_TIMEOUT_MS;

  const result = await synthesizeSpeechWithWorkersAi(ctx.env.AI, {
    text,
    model,
    voice,
    encoding,
    timeoutMs,
    language: normalizeOptionalString(input.language),
    container: normalizeOptionalString(input.container),
    sampleRate: normalizePositiveNumber(input.sampleRate),
    bitRate: normalizePositiveNumber(input.bitRate),
  });
  if (!result) {
    throw new Error("Speech synthesis unavailable");
  }

  return {
    audio: {
      data: result.data,
      mimeType: result.mimeType,
      size: result.size,
    },
    provider: result.provider,
    model: result.model,
    ...(result.voice ? { voice: result.voice } : {}),
    ...(result.encoding ? { encoding: result.encoding } : {}),
    ...(result.container ? { container: result.container } : {}),
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

function normalizeGenerationStreaming(value: string | null | undefined): "auto" | "off" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "off" ? "off" : DEFAULT_GENERATION_STREAMING;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function base64DecodedLength(base64: string): number {
  const clean = base64.replace(/\s/g, "");
  if (!clean) {
    return 0;
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
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
