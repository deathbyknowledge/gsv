/**
 * ai.* syscall handlers.
 *
 * ai.tools — returns available tool schemas, online devices, and ready MCP servers accessible to caller.
 * ai.config — reads model/provider/apiKey from /sys/ (kernel SQLite via ConfigStore).
 *
 * Config resolution order:
 *   process overrides → /sys/users/{run-as uid}/ai/* → /sys/users/{owner uid}/ai/* → /sys/config/ai/*
 *   A users/{uid}/ai/model_profile selection expands into that account's step.
 *
 * Runtime reads are explicit SQLite overrides over code defaults.
 */

import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type {
  AiToolsResult,
  AiToolsDevice,
  AiConfigArgs,
  AiConfigFallback,
  AiConfigResult,
  AiAssistantMessage,
  AiTextGenerateArgs,
  AiTextGenerateConfig,
  AiTextGenerateOptions,
  AiTextGenerateResult,
  AiTextMessage,
  AiTextTool,
  AiImageGenerateArgs,
  AiImageGenerateResult,
  AiImageReadArgs,
  AiImageReadResult,
  AiSpeechCreateArgs,
  AiSpeechCreateResult,
  AiTranscriptionCreateArgs,
  AiTranscriptionCreateResult,
  ContextFile,
} from "../syscalls/ai";
import type {
  ProcAiConfigGetResult,
  ProcAiConfigProfileRef,
} from "../syscalls/proc";
import type { ToolDefinition, SyscallName } from "../syscalls";
import { intoSyscallTool, isRoutableSyscall } from "../syscalls";
import {
  buildCodeModeMcpToolBindings,
  buildCodeModeMcpTypeDeclarations,
  type CodeModeMcpToolSource,
} from "../codemode/mcp";
import { hasCapability } from "./capabilities";

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
import { resolveModelContextWindowFromRegistry } from "../inference/model-registry";
import {
  createGenerationService,
  extractGeneratedText,
} from "../inference/service";
import { createRoutedFetch, normalizeTarget, type NetFetchDeviceTransport } from "./net";
import {
  DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES,
  normalizeBase64Data,
} from "../inference/transcription";
import {
  DEFAULT_IMAGE_READING_MAX_TOKENS,
  DEFAULT_IMAGE_READING_INPUT_FORMAT,
  DEFAULT_IMAGE_READING_MODEL,
  DEFAULT_IMAGE_READING_PROMPT,
  DEFAULT_IMAGE_READING_TIMEOUT_MS,
  DEFAULT_MAX_IMAGE_READING_BYTES,
  normalizeImageReadingInputFormat,
  readImageWithPiAi,
  readImageWithWorkersAi,
} from "../inference/image-reading";
import {
  DEFAULT_AUDIO_SPEECH_ENCODING,
  DEFAULT_AUDIO_SPEECH_MODEL,
  DEFAULT_AUDIO_SPEECH_SPEAKER,
  DEFAULT_AUDIO_SPEECH_TIMEOUT_MS,
  DEFAULT_MAX_AUDIO_SPEECH_CHARS,
} from "../inference/speech";
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_OPENAI_SPEECH_MODEL,
  DEFAULT_OPENAI_SPEECH_VOICE,
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  generateImage,
  synthesizeSpeech,
  transcribeAudio,
} from "../inference/capabilities";
import {
  normalizeSpeechText,
  normalizeSpeechTextFormat,
} from "@humansandmachines/gsv/protocol";
import { collectPromptSkillIndex } from "./skills";
import { listVisibleTargets, targetToAiDevice } from "./targets";
import {
  findProcessAiModelProfile,
  isProcessAiConfigKey,
  omitProcessAiConfigSecrets,
  parseProcessAiModelProfiles,
  PROCESS_AI_CONFIG_SECRET_KEYS,
  processAiModelProfileSecretConfigKey,
} from "../process/ai-config";
import { sendFrameToProcess } from "../shared/utils";

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

const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const DEFAULT_GENERATION_STREAMING = "auto";

type AiAccountProfileOverrides = Map<number, Record<string, string>>;
type AiModelStackConfig = Pick<
  AiConfigResult,
  | "provider"
  | "model"
  | "apiKey"
  | "baseUrl"
  | "providerStyle"
  | "transportTarget"
  | "reasoning"
  | "maxTokens"
  | "contextWindowTokens"
  | "contextWindowSource"
  | "generationTimeoutMs"
  | "generationStreaming"
>;
const ACCOUNT_MODEL_PROFILE_INFERENCE_BLOCKERS = [
  "provider",
  "base_url",
  "provider_style",
  "transport_target",
  "api_key",
] as const;

export async function handleAiTools(
  ctx: KernelContext,
): Promise<AiToolsResult> {
  const identity = ctx.identity!;
  const capabilities = identity.capabilities;
  const canUseMcpTools = hasCapability(capabilities, "sys.mcp.list")
    && hasCapability(capabilities, "sys.mcp.call");
  const mcpUid = resolveCallerOwnerUid(ctx);

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
      tools.push(canUseMcpTools ? withCodeModeMcpTypeHints(baseDef, ctx, mcpUid) : baseDef);
    } else {
      tools.push(baseDef);
    }
  }

  return {
    tools,
    devices: onlineDevices,
    mcpServers: canUseMcpTools ? listReadyMcpServerNames(ctx, mcpUid) : [],
  };
}

export async function handleAiConfig(
  args: AiConfigArgs,
  ctx: KernelContext,
): Promise<AiConfigResult> {
  const config = ctx.config;
  const uid = ctx.identity?.process.uid ?? 0;
  const owner = resolveOwnerIdentity(ctx);
  const accountConfigUids = resolveAiConfigAccountUids(uid, owner);
  const input = args && typeof args === "object" ? args : ({} as AiConfigArgs);
  const processOverrides = resolveEffectiveAiProcessOverrides(
    ctx,
    uid,
    owner,
    input.processOverrides,
    input.processProfile,
  );
  const accountProfileOverrides = resolveAiAccountProfileOverrides(config, accountConfigUids);

  const provider =
    resolveAiProcessConfigValue(processOverrides, "provider") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "provider") ??
    config.get("config/ai/provider") ??
    "workers-ai";

  const model =
    resolveAiProcessConfigValue(processOverrides, "model") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "model") ??
    config.get("config/ai/model") ??
    "@cf/nvidia/nemotron-3-120b-a12b";

  const baseUrl =
    resolveAiProcessConfigValue(processOverrides, "base_url") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "base_url") ??
    config.get("config/ai/base_url") ??
    "";

  const providerStyle =
    resolveAiProcessConfigValue(processOverrides, "provider_style") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "provider_style") ??
    config.get("config/ai/provider_style") ??
    "auto";

  const transportTarget =
    resolveAiProcessConfigValue(processOverrides, "transport_target") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "transport_target") ??
    config.get("config/ai/transport_target") ??
    "gsv";

  const apiKey =
    resolveAiProcessConfigValue(processOverrides, "api_key") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "api_key") ??
    config.get("config/ai/api_key") ??
    "";

  const reasoning =
    resolveAiProcessConfigValue(processOverrides, "reasoning") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "reasoning") ??
    config.get("config/ai/reasoning") ??
    undefined;

  const maxTokens = parseInt(
    resolveAiProcessConfigValue(processOverrides, "max_tokens") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "max_tokens") ??
    config.get("config/ai/max_tokens") ??
    "8192",
    10,
  );
  const contextWindowOverride = parsePositiveInt(
    resolveAiProcessConfigValue(processOverrides, "context_window_tokens") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "context_window_tokens"),
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

  // Persona and context come from the run-as account's home (the home.context
  // provider reads /home/<account>/context.d). Tool approval follows the same
  // account default order as model config, so humans can own defaults for their
  // agents while agents can still override them.
  const accountApprovalPolicy = resolveAccountApprovalPolicy(config, accountConfigUids);

  const maxContextBytes = parseInt(
    resolveAiProcessConfigValue(processOverrides, "max_context_bytes") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "max_context_bytes") ??
    config.get("config/ai/max_context_bytes") ??
    "32768",
    10,
  );
  const generationTimeoutMs = parsePositiveInt(
    resolveAiProcessConfigValue(processOverrides, "generation/timeout_ms"),
  ) ?? parsePositiveInt(
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "generation/timeout_ms"),
  ) ?? parsePositiveInt(
    config.get("config/ai/generation/timeout_ms"),
  ) ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationStreaming = normalizeGenerationStreaming(
    resolveAiProcessConfigValue(processOverrides, "generation/streaming") ??
    resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "generation/streaming") ??
    config.get("config/ai/generation/streaming"),
  );
  const processFallbackModelProfile = resolveAiProcessConfigValue(processOverrides, "fallback_model_profile");
  const accountFallbackModelProfile = resolveAiConfigValue(
    config,
    accountConfigUids,
    accountProfileOverrides,
    "fallback_model_profile",
  );
  const systemFallbackModelProfile = config.get("config/ai/fallback_model_profile");
  const fallbackModelProfile =
    processFallbackModelProfile ??
    accountFallbackModelProfile ??
    systemFallbackModelProfile ??
    "";
  const fallbackAccountUids = processFallbackModelProfile === null &&
    accountFallbackModelProfile === null &&
    systemFallbackModelProfile !== null
    ? withRootAiProfileScope(accountConfigUids)
    : accountConfigUids;
  const fallbacks = await resolveAiFallbackConfigs({
    config,
    accountUids: fallbackAccountUids,
    selector: fallbackModelProfile,
    primary: {
      provider,
      model,
      apiKey,
      ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
      providerStyle: providerStyle.trim().toLowerCase() || "auto",
      transportTarget: normalizeTarget(transportTarget),
      reasoning,
      maxTokens,
      contextWindowTokens,
      contextWindowSource,
      generationTimeoutMs,
      generationStreaming,
    },
  });
  const media = resolveAiMediaConfig(config, accountConfigUids, accountProfileOverrides, apiKey, processOverrides);
  const timezone = config.get("config/server/timezone") ?? "UTC";
  const skillIndex = await collectPromptSkillIndex(ctx).catch((error) => {
    console.warn(
      `[Prompt] failed to collect skills.d index: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  });

  return {
    owner,
    executor: resolveAiTextExecutor(ctx),
    provider,
    model,
    apiKey,
    ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
    providerStyle: providerStyle.trim().toLowerCase() || "auto",
    transportTarget: normalizeTarget(transportTarget),
    reasoning,
    maxTokens,
    contextWindowTokens,
    contextWindowSource,
    systemContextFiles,
    system: {
      timezone,
    },
    skillIndex,
    accountApprovalPolicy,
    capabilities: [...ctx.identity!.capabilities],
    maxContextBytes,
    generationTimeoutMs,
    generationStreaming,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
    media,
  };
}

export async function handleAiTextGenerate(
  args: AiTextGenerateArgs,
  ctx: KernelContext,
  transport?: NetFetchDeviceTransport,
): Promise<AiTextGenerateResult> {
  const input = args && typeof args === "object" ? args : ({} as AiTextGenerateArgs);
  const target = normalizeOptionalString(input.target) ?? "gsv";
  if (target !== "gsv") {
    // TODO: implement device ai gen + routing.
    throw new Error(`AI text generation target is not available: ${target}`);
  }

  const config = await resolveAiTextGenerationConfig(input.config, ctx);
  const context = normalizeAiTextGenerationContext(input);
  const options = normalizeAiTextGenerateOptions(input.options);
  const response = await createGenerationService({
    fetch: createRoutedFetch(ctx, transport, config.transportTarget),
  }).generate({
    config,
    context,
    ...(options ? { options } : {}),
    sessionAffinityKey: normalizeOptionalString(input.sessionAffinityKey),
  });
  const text = extractGeneratedText(response);
  return {
    message: response as unknown as AiAssistantMessage,
    provider: response.provider || config.provider,
    model: response.model || config.model,
    ...(text ? { text } : {}),
  };
}

function normalizeAiProcessOverrideValues(raw: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isProcessAiConfigKey(key)) {
      continue;
    }
    const normalized = String(value ?? "").trim();
    if (!normalized && !PROCESS_AI_CONFIG_SECRET_KEYS.has(key)) {
      continue;
    }
    values[key] = normalized;
  }
  return values;
}

export async function handleAiTranscriptionCreate(
  args: AiTranscriptionCreateArgs,
  ctx: KernelContext,
): Promise<AiTranscriptionCreateResult> {
  const media = await resolveAiMediaConfigForContext(ctx);
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
  const maxBytes = media.transcriptionMaxBytes;
  if (byteLength <= 0) {
    throw new Error("audio.data is empty");
  }
  if (byteLength > maxBytes) {
    throw new Error(`audio.data exceeds transcription limit (${maxBytes} bytes)`);
  }

  const mode = args.mode === "translate" ? "translate" : "transcribe";
  const result = await transcribeAudio({
    workersAi: ctx.env.AI,
  }, {
    data: base64,
    provider: media.transcriptionProvider,
    apiKey: media.transcriptionApiKey,
    model: media.transcriptionModel,
    mimeType: audio.mimeType,
    filename: audio.filename,
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

export async function handleAiImageRead(
  args: AiImageReadArgs,
  ctx: KernelContext,
): Promise<AiImageReadResult> {
  const input = args && typeof args === "object" ? args : ({} as AiImageReadArgs);
  const media = await resolveAiMediaConfigForContext(ctx);
  const image = input.image;
  if (!image || typeof image !== "object") {
    throw new Error("image is required");
  }
  if (typeof image.data !== "string" || image.data.trim().length === 0) {
    throw new Error("image.data is required");
  }
  if (typeof image.mimeType !== "string" || !image.mimeType.trim().toLowerCase().startsWith("image/")) {
    throw new Error("image.mimeType must be an image MIME type");
  }

  const base64 = normalizeBase64Data(image.data.trim());
  const byteLength = base64DecodedLength(base64);
  const maxBytes = media.imageReadingMaxBytes;
  if (byteLength <= 0) {
    throw new Error("image.data is empty");
  }
  if (byteLength > maxBytes) {
    throw new Error(`image.data exceeds image reading limit (${maxBytes} bytes)`);
  }

  const model = normalizeOptionalString(input.model) ?? media.imageReadingModel;
  const request = {
    data: base64,
    provider: media.imageReadingProvider,
    apiKey: media.imageReadingApiKey,
    model,
    mimeType: image.mimeType,
    prompt: normalizeOptionalString(input.prompt) ?? media.imageReadingPrompt,
    inputFormat: normalizeImageReadingInputFormat(input.inputFormat) ?? media.imageReadingInputFormat,
    maxTokens: normalizePositiveNumber(input.maxTokens) ?? media.imageReadingMaxTokens,
    timeoutMs: media.imageReadingTimeoutMs,
  };
  const result = isWorkersAiProvider(media.imageReadingProvider)
    ? await readImageWithWorkersAi(ctx.env.AI, request)
    : await readImageWithPiAi(request);
  if (!result) {
    throw new Error("Image reading unavailable");
  }

  return result;
}

export async function handleAiImageGenerate(
  args: AiImageGenerateArgs,
  ctx: KernelContext,
): Promise<AiImageGenerateResult> {
  const input = args && typeof args === "object" ? args : ({} as AiImageGenerateArgs);
  const media = await resolveAiMediaConfigForContext(ctx);
  const prompt = normalizeOptionalString(input.prompt);
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const result = await generateImage({
    workersAi: ctx.env.AI,
  }, {
    provider: media.imageGenerationProvider,
    apiKey: media.imageGenerationApiKey,
    model: normalizeOptionalString(input.model) ?? media.imageGenerationModel,
    prompt,
    size: normalizeOptionalString(input.size),
    quality: normalizeOptionalString(input.quality),
    format: normalizeOptionalString(input.format),
    timeoutMs: normalizePositiveNumber(input.timeoutMs),
  });
  if (!result) {
    throw new Error("Image generation unavailable");
  }

  return {
    image: {
      data: result.data,
      mimeType: result.mimeType,
      size: result.size,
    },
    provider: result.provider,
    model: result.model,
    ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
    ...(result.url ? { url: result.url } : {}),
  };
}

export async function handleAiSpeechCreate(
  args: AiSpeechCreateArgs,
  ctx: KernelContext,
): Promise<AiSpeechCreateResult> {
  const input = args && typeof args === "object" ? args : ({} as AiSpeechCreateArgs);
  const media = await resolveAiMediaConfigForContext(ctx);
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

  const maxChars = media.speechMaxChars;
  if (text.length > maxChars) {
    throw new Error(`text exceeds speech limit (${maxChars} chars)`);
  }

  const model = normalizeOptionalString(input.model)
    ?? media.speechModel;
  const voice = normalizeOptionalString(input.voice)
    ?? media.speechSpeaker;
  const encoding = normalizeOptionalString(input.encoding)
    ?? media.speechEncoding;
  const timeoutMs = media.speechTimeoutMs;

  const result = await synthesizeSpeech({
    workersAi: ctx.env.AI,
  }, {
    provider: media.speechProvider,
    apiKey: media.speechApiKey,
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

async function resolveAiTextGenerationConfig(
  input: AiTextGenerateConfig | undefined,
  ctx: KernelContext,
): Promise<AiConfigResult> {
  const requested = input && typeof input === "object" ? input : undefined;
  const overrides = normalizeAiProcessOverrideValues({
    ...(requested?.processOverrides ?? {}),
    ...(requested?.overrides ?? {}),
  });
  const processProfile = requested?.processProfile;
  const preset = requested?.preset;
  if (!preset) {
    return withAiTextExecutor(
      await handleAiConfig(
        Object.keys(overrides).length > 0 || processProfile
          ? {
              processOverrides: overrides,
              processProfile: processProfile ?? null,
            }
          : {},
        ctx,
      ),
      { kind: "kernel" },
    );
  }

  const selector = normalizeOptionalString(preset.id) ?? normalizeOptionalString(preset.name);
  if (!selector) {
    throw new Error("config.preset requires id or name");
  }

  const uid = ctx.identity?.process.uid ?? 0;
  const owner = resolveOwnerIdentity(ctx);
  const ownerUid = resolveAiProfileOwnerUid(ctx, uid, owner);
  const profile = findProcessAiModelProfile(
    ctx.config.get(`users/${ownerUid}/ai/model_profiles`),
    ownerUid,
    selector,
  );
  if (!profile) {
    throw new Error(`AI model preset not found: ${selector}`);
  }

  const config = await handleAiConfig({
    processOverrides: {
      ...omitProcessAiConfigSecrets(profile.values),
      ...overrides,
    },
    processProfile: {
      id: profile.id,
      name: profile.name,
      appliedAt: Date.now(),
    },
  }, ctx);
  return withAiTextExecutor(config, { kind: "kernel" });
}

function resolveAiTextExecutor(ctx: KernelContext): AiConfigResult["executor"] {
  if (ctx.processId) {
    return {
      kind: "process",
      pid: ctx.processId,
    };
  }
  return { kind: "kernel" };
}

function withAiTextExecutor(
  config: AiConfigResult,
  executor: AiConfigResult["executor"],
): AiConfigResult {
  return {
    ...config,
    executor,
  };
}

function normalizeAiTextGenerationContext(input: AiTextGenerateArgs): Context {
  if (!Array.isArray(input.messages)) {
    throw new Error("messages must be an array");
  }
  const tools = Array.isArray(input.tools)
    ? input.tools.map(normalizeAiTextTool)
    : undefined;
  return {
    systemPrompt: typeof input.systemPrompt === "string" ? input.systemPrompt : "",
    messages: input.messages.map(normalizeAiTextMessage),
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

function normalizeAiTextMessage(message: AiTextMessage, index: number): Message {
  if (!message || typeof message !== "object") {
    throw new Error(`messages[${index}] must be an object`);
  }
  const timestamp = normalizeTimestamp((message as { timestamp?: unknown }).timestamp);
  if (message.role === "user") {
    return {
      ...message,
      timestamp,
    } as unknown as Message;
  }
  if (message.role === "assistant") {
    return {
      ...message,
      timestamp,
    } as unknown as Message;
  }
  if (message.role === "toolResult") {
    return {
      ...message,
      timestamp,
    } as unknown as Message;
  }
  throw new Error(`messages[${index}].role is unsupported`);
}

function normalizeAiTextTool(tool: AiTextTool, index: number): Tool {
  if (!tool || typeof tool !== "object") {
    throw new Error(`tools[${index}] must be an object`);
  }
  const name = normalizeOptionalString(tool.name);
  if (!name) {
    throw new Error(`tools[${index}].name is required`);
  }
  return {
    name,
    description: typeof tool.description === "string" ? tool.description : "",
    parameters: tool.parameters && typeof tool.parameters === "object"
      ? tool.parameters as Tool["parameters"]
      : {},
  };
}

function normalizeAiTextGenerateOptions(
  input: AiTextGenerateOptions | undefined,
): AiTextGenerateOptions | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const options: AiTextGenerateOptions = {};
  const maxTokens = normalizePositiveNumber(input.maxTokens);
  if (maxTokens !== undefined) {
    options.maxTokens = Math.floor(maxTokens);
  }
  const timeoutMs = normalizePositiveNumber(input.timeoutMs);
  if (timeoutMs !== undefined) {
    options.timeoutMs = Math.floor(timeoutMs);
  }
  const reasoning = normalizeAiTextGenerationReasoning(input.reasoning);
  if (reasoning) {
    options.reasoning = reasoning;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function normalizeAiTextGenerationReasoning(
  value: unknown,
): AiTextGenerateOptions["reasoning"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "inherit" ||
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  throw new Error("options.reasoning must be inherit, off, minimal, low, medium, high, or xhigh");
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Date.now();
}

/**
 * Resolve the owning human's identity for the calling process, when it runs as
 * a distinct agent account (owner_uid differs from the run-as uid). Returns null
 * for processes that run as their own owner or for non-process callers.
 */
function resolveOwnerIdentity(ctx: KernelContext): ProcessIdentity | null {
  if (!ctx.processId) return null;
  const ownerUid = ctx.procs.getOwnerUid(ctx.processId);
  if (ownerUid === null) return null;
  const runAsUid = ctx.identity?.process.uid;
  if (ownerUid === runAsUid) return null;

  const entry = ctx.auth.getPasswdByUid(ownerUid);
  if (!entry) return null;
  return {
    uid: entry.uid,
    gid: entry.gid,
    gids: ctx.auth.resolveGids(entry.username, entry.gid),
    username: entry.username,
    home: entry.home,
    cwd: entry.home,
  };
}

function resolveAiConfigAccountUids(uid: number, owner: ProcessIdentity | null): number[] {
  if (!owner || owner.uid === uid) {
    return [uid];
  }
  return [uid, owner.uid];
}

function withRootAiProfileScope(accountUids: number[]): number[] {
  return accountUids.includes(0) ? accountUids : [0, ...accountUids];
}

function resolveAiConfigValue(
  config: KernelContext["config"],
  accountUids: number[],
  accountProfileOverrides: AiAccountProfileOverrides,
  key: string,
): string | null {
  for (const accountUid of accountUids) {
    const profileValue = resolveAiProcessConfigValue(
      accountProfileOverrides.get(accountUid) ?? {},
      key,
    );
    if (profileValue !== null) {
      return profileValue;
    }
    const value = config.get(`users/${accountUid}/ai/${key}`);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function resolveAiProcessConfigValue(
  processOverrides: Record<string, string>,
  key: string,
): string | null {
  const fullKey = `config/ai/${key}`;
  return Object.prototype.hasOwnProperty.call(processOverrides, fullKey)
    ? processOverrides[fullKey]
    : null;
}

async function resolveAiFallbackConfigs(options: {
  config: KernelContext["config"];
  accountUids: number[];
  selector: string;
  primary: AiModelStackConfig;
}): Promise<AiConfigFallback[]> {
  const selector = normalizeOptionalString(options.selector);
  if (!selector || options.accountUids.length === 0) {
    return [];
  }
  const profile = findAiAccountModelProfile(
    options.config,
    options.accountUids,
    options.accountUids[0],
    selector,
  );
  if (!profile) {
    return [];
  }
  const fallback = await resolveAiFallbackModelStack(
    options.config,
    options.accountUids,
    profile.values,
  );
  if (isSameAiModelStack(options.primary, fallback)) {
    return [];
  }
  return [{
    profileId: profile.id,
    profileName: profile.name,
    ...fallback,
  }];
}

async function resolveAiFallbackModelStack(
  config: KernelContext["config"],
  accountUids: number[],
  profileOverrides: Record<string, string>,
): Promise<AiModelStackConfig> {
  const emptyProfileOverrides: AiAccountProfileOverrides = new Map();
  const provider =
    resolveAiProcessConfigValue(profileOverrides, "provider") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "provider") ??
    config.get("config/ai/provider") ??
    "workers-ai";
  const model =
    resolveAiProcessConfigValue(profileOverrides, "model") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "model") ??
    config.get("config/ai/model") ??
    "@cf/nvidia/nemotron-3-120b-a12b";
  const baseUrl =
    resolveAiProcessConfigValue(profileOverrides, "base_url") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "base_url") ??
    config.get("config/ai/base_url") ??
    "";
  const providerStyle =
    resolveAiProcessConfigValue(profileOverrides, "provider_style") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "provider_style") ??
    config.get("config/ai/provider_style") ??
    "auto";
  const transportTarget =
    resolveAiProcessConfigValue(profileOverrides, "transport_target") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "transport_target") ??
    config.get("config/ai/transport_target") ??
    "gsv";
  const apiKey =
    resolveAiProcessConfigValue(profileOverrides, "api_key") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "api_key") ??
    config.get("config/ai/api_key") ??
    "";
  const reasoning =
    resolveAiProcessConfigValue(profileOverrides, "reasoning") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "reasoning") ??
    config.get("config/ai/reasoning") ??
    undefined;
  const maxTokens = parseInt(
    resolveAiProcessConfigValue(profileOverrides, "max_tokens") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "max_tokens") ??
    config.get("config/ai/max_tokens") ??
    "8192",
    10,
  );
  const contextWindowOverride = parsePositiveInt(
    resolveAiProcessConfigValue(profileOverrides, "context_window_tokens") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "context_window_tokens"),
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
  const generationTimeoutMs = parsePositiveInt(
    resolveAiProcessConfigValue(profileOverrides, "generation/timeout_ms"),
  ) ?? parsePositiveInt(
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "generation/timeout_ms"),
  ) ?? parsePositiveInt(
    config.get("config/ai/generation/timeout_ms"),
  ) ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationStreaming = normalizeGenerationStreaming(
    resolveAiProcessConfigValue(profileOverrides, "generation/streaming") ??
    resolveAiConfigValue(config, accountUids, emptyProfileOverrides, "generation/streaming") ??
    config.get("config/ai/generation/streaming"),
  );

  return {
    provider,
    model,
    apiKey,
    ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
    providerStyle: providerStyle.trim().toLowerCase() || "auto",
    transportTarget: normalizeTarget(transportTarget),
    reasoning,
    maxTokens,
    contextWindowTokens,
    contextWindowSource,
    generationTimeoutMs,
    generationStreaming,
  };
}

function isSameAiModelStack(
  left: AiModelStackConfig,
  right: AiModelStackConfig,
): boolean {
  return left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase() &&
    left.model.trim().toLowerCase() === right.model.trim().toLowerCase() &&
    (left.baseUrl ?? "").trim() === (right.baseUrl ?? "").trim() &&
    (left.providerStyle ?? "auto").trim().toLowerCase() === (right.providerStyle ?? "auto").trim().toLowerCase() &&
    normalizeTarget(left.transportTarget) === normalizeTarget(right.transportTarget);
}

async function resolveAiMediaConfigForContext(ctx: KernelContext): Promise<NonNullable<AiConfigResult["media"]>> {
  const uid = ctx.identity?.process.uid ?? 0;
  const owner = resolveOwnerIdentity(ctx);
  const accountConfigUids = resolveAiConfigAccountUids(uid, owner);
  const processOverrides = await resolveAiProcessOverridesForContext(ctx, uid, owner);
  const accountProfileOverrides = resolveAiAccountProfileOverrides(ctx.config, accountConfigUids);
  const apiKey =
    resolveAiProcessConfigValue(processOverrides, "api_key") ??
    resolveAiConfigValue(ctx.config, accountConfigUids, accountProfileOverrides, "api_key") ??
    ctx.config.get("config/ai/api_key") ??
    "";
  return resolveAiMediaConfig(ctx.config, accountConfigUids, accountProfileOverrides, apiKey, processOverrides);
}

async function resolveAiProcessOverridesForContext(
  ctx: KernelContext,
  uid: number,
  owner: ProcessIdentity | null,
): Promise<Record<string, string>> {
  if (!ctx.processId) {
    return {};
  }

  let frame: Awaited<ReturnType<typeof sendFrameToProcess>>;
  try {
    frame = await sendFrameToProcess(ctx.processId, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.ai.config.get",
      args: { redacted: false },
    });
  } catch {
    return {};
  }
  if (!frame || frame.type !== "res" || !frame.ok) {
    return {};
  }

  const result = frame.data as ProcAiConfigGetResult;
  if (!result.ok || !result.config) {
    return {};
  }
  return resolveEffectiveAiProcessOverrides(
    ctx,
    uid,
    owner,
    result.config.values,
    result.config.profile,
  );
}

function resolveEffectiveAiProcessOverrides(
  ctx: KernelContext,
  uid: number,
  owner: ProcessIdentity | null,
  processOverrides: Record<string, unknown> | undefined,
  processProfile: ProcAiConfigProfileRef | null | undefined,
): Record<string, string> {
  const profileSecretOverrides = resolveAiProfileSecretOverrides(
    ctx.config,
    resolveAiProfileOwnerUid(ctx, uid, owner),
    processProfile,
  );
  const normalizedOverrides = normalizeAiProcessOverrideValues(processOverrides ?? {});
  return {
    ...profileSecretOverrides,
    ...normalizedOverrides,
  };
}

function resolveAiAccountProfileOverrides(
  config: KernelContext["config"],
  accountUids: number[],
): AiAccountProfileOverrides {
  const overrides: AiAccountProfileOverrides = new Map();
  for (const accountUid of accountUids) {
    const explicitSelector = normalizeOptionalString(config.get(`users/${accountUid}/ai/model_profile`));
    const inferredSelector = explicitSelector
      ? undefined
      : inferAiAccountModelProfileSelector(config, accountUid);
    const selector = explicitSelector ?? inferredSelector;
    if (!selector) {
      continue;
    }
    const profile = findAiAccountModelProfile(config, accountUids, accountUid, selector, {
      matchModel: Boolean(inferredSelector),
    });
    if (profile) {
      overrides.set(accountUid, profile.values);
    }
  }
  return overrides;
}

function findAiAccountModelProfile(
  config: KernelContext["config"],
  accountUids: number[],
  accountUid: number,
  selector: string,
  options: { matchModel?: boolean } = {},
) {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const ownerCandidates = [
    accountUid,
    ...accountUids.filter((candidateUid) => candidateUid !== accountUid),
  ];
  for (const ownerUid of ownerCandidates) {
    const profiles = parseProcessAiModelProfiles(
      config.get(`users/${ownerUid}/ai/model_profiles`),
      ownerUid,
      (key) => config.get(key),
    );
    const profile = profiles.find((candidate) =>
      candidate.id.toLowerCase() === normalized ||
      candidate.name.toLowerCase() === normalized ||
      (
        options.matchModel === true &&
        candidate.values["config/ai/model"]?.trim().toLowerCase() === normalized
      )
    );
    if (profile) {
      return profile;
    }
  }
  return null;
}

function inferAiAccountModelProfileSelector(
  config: KernelContext["config"],
  accountUid: number,
): string | undefined {
  const model = normalizeOptionalString(config.get(`users/${accountUid}/ai/model`));
  if (!model) {
    return undefined;
  }
  const hasProviderStackOverride = ACCOUNT_MODEL_PROFILE_INFERENCE_BLOCKERS.some((key) =>
    normalizeOptionalString(config.get(`users/${accountUid}/ai/${key}`)),
  );
  return hasProviderStackOverride ? undefined : model;
}

function resolveAiProfileOwnerUid(
  ctx: KernelContext,
  uid: number,
  owner: ProcessIdentity | null,
): number {
  if (owner) {
    return owner.uid;
  }
  if (ctx.processId) {
    const processOwnerUid = ctx.procs.getOwnerUid(ctx.processId);
    if (processOwnerUid !== null) {
      return processOwnerUid;
    }
  }
  return uid;
}

function resolveAiProfileSecretOverrides(
  config: KernelContext["config"],
  ownerUid: number,
  profile: ProcAiConfigProfileRef | null | undefined,
): Record<string, string> {
  const profileId = normalizeOptionalString(profile?.id);
  if (!profileId) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const key of PROCESS_AI_CONFIG_SECRET_KEYS) {
    const value = normalizeOptionalString(
      config.get(processAiModelProfileSecretConfigKey(ownerUid, profileId, key)),
    );
    if (value) {
      values[key] = value;
    }
  }
  return values;
}

function resolveAiMediaConfig(
  config: KernelContext["config"],
  accountUids: number[],
  accountProfileOverrides: AiAccountProfileOverrides,
  defaultApiKey: string,
  processOverrides: Record<string, string>,
): NonNullable<AiConfigResult["media"]> {
  const transcriptionProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "transcription/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "transcription/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/transcription/provider")) ??
    "workers-ai";
  const transcriptionModel =
    resolveAiProcessConfigValue(processOverrides, "transcription/model") ??
    resolveAiConfigValue(config, accountUids, accountProfileOverrides, "transcription/model") ??
    getExplicitConfigValue(config, "config/ai/transcription/model") ??
    defaultTranscriptionModelForProvider(transcriptionProvider);
  const transcriptionApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "transcription/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "transcription/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/transcription/api_key")) ??
    defaultApiKey;
  const transcriptionMaxBytes =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "transcription/max_bytes")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "transcription/max_bytes")) ??
    parsePositiveInt(config.get("config/ai/transcription/max_bytes")) ??
    DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES;
  const imageReadingProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "image/read/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/image/read/provider")) ??
    "workers-ai";
  const imageReadingModel =
    resolveAiProcessConfigValue(processOverrides, "image/read/model") ??
    resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/model") ??
    getExplicitConfigValue(config, "config/ai/image/read/model") ??
    defaultImageReadingModelForProvider(imageReadingProvider);
  const imageReadingApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "image/read/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/image/read/api_key")) ??
    defaultApiKey;
  const imageReadingInputFormat =
    normalizeImageReadingInputFormat(resolveAiProcessConfigValue(processOverrides, "image/read/input_format")) ??
    normalizeImageReadingInputFormat(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/input_format")) ??
    normalizeImageReadingInputFormat(config.get("config/ai/image/read/input_format")) ??
    DEFAULT_IMAGE_READING_INPUT_FORMAT;
  const imageReadingMaxBytes =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "image/read/max_bytes")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/max_bytes")) ??
    parsePositiveInt(config.get("config/ai/image/read/max_bytes")) ??
    DEFAULT_MAX_IMAGE_READING_BYTES;
  const imageReadingMaxTokens =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "image/read/max_tokens")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/max_tokens")) ??
    parsePositiveInt(config.get("config/ai/image/read/max_tokens")) ??
    DEFAULT_IMAGE_READING_MAX_TOKENS;
  const imageReadingTimeoutMs =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "image/read/timeout_ms")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/timeout_ms")) ??
    parsePositiveInt(config.get("config/ai/image/read/timeout_ms")) ??
    DEFAULT_IMAGE_READING_TIMEOUT_MS;
  const imageReadingPrompt =
    resolveAiProcessConfigValue(processOverrides, "image/read/prompt") ??
    resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/read/prompt") ??
    config.get("config/ai/image/read/prompt") ??
    DEFAULT_IMAGE_READING_PROMPT;
  const imageGenerationProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "image/generation/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/generation/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/image/generation/provider")) ??
    "workers-ai";
  const imageGenerationModel =
    resolveAiProcessConfigValue(processOverrides, "image/generation/model") ??
    resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/generation/model") ??
    getExplicitConfigValue(config, "config/ai/image/generation/model") ??
    defaultImageGenerationModelForProvider(imageGenerationProvider);
  const imageGenerationApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "image/generation/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "image/generation/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/image/generation/api_key")) ??
    defaultApiKey;
  const speechProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "speech/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "speech/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/speech/provider")) ??
    "workers-ai";
  const speechModel =
    resolveAiProcessConfigValue(processOverrides, "speech/model") ??
    resolveAiConfigValue(config, accountUids, accountProfileOverrides, "speech/model") ??
    getExplicitConfigValue(config, "config/ai/speech/model") ??
    defaultSpeechModelForProvider(speechProvider);
  const speechApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "speech/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "speech/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/speech/api_key")) ??
    defaultApiKey;
  const speechSpeaker =
    resolveAiProcessConfigValue(processOverrides, "speech/speaker") ??
    resolveAiConfigValue(config, accountUids, accountProfileOverrides, "speech/speaker") ??
    getExplicitConfigValue(config, "config/ai/speech/speaker") ??
    defaultSpeechSpeakerForProvider(speechProvider);
  const speechEncoding =
    resolveAiProcessConfigValue(processOverrides, "speech/encoding") ??
    resolveAiConfigValue(config, accountUids, accountProfileOverrides, "speech/encoding") ??
    config.get("config/ai/speech/encoding") ??
    DEFAULT_AUDIO_SPEECH_ENCODING;
  const speechMaxChars =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "speech/max_chars")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "speech/max_chars")) ??
    parsePositiveInt(config.get("config/ai/speech/max_chars")) ??
    DEFAULT_MAX_AUDIO_SPEECH_CHARS;
  const speechTimeoutMs =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "speech/timeout_ms")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, accountProfileOverrides, "speech/timeout_ms")) ??
    parsePositiveInt(config.get("config/ai/speech/timeout_ms")) ??
    DEFAULT_AUDIO_SPEECH_TIMEOUT_MS;

  return {
    transcriptionProvider,
    transcriptionModel,
    transcriptionApiKey,
    transcriptionMaxBytes,
    imageReadingProvider,
    imageReadingModel,
    imageReadingApiKey,
    imageReadingInputFormat,
    imageReadingMaxBytes,
    imageReadingMaxTokens,
    imageReadingTimeoutMs,
    imageReadingPrompt,
    imageGenerationProvider,
    imageGenerationModel,
    imageGenerationApiKey,
    speechProvider,
    speechModel,
    speechApiKey,
    speechSpeaker,
    speechEncoding,
    speechMaxChars,
    speechTimeoutMs,
  };
}

function getExplicitConfigValue(config: KernelContext["config"], key: string): string | null {
  const withExplicit = config as KernelContext["config"] & {
    getExplicit?: (key: string) => string | null;
  };
  return typeof withExplicit.getExplicit === "function"
    ? withExplicit.getExplicit(key)
    : config.get(key);
}

function normalizeProviderName(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized ?? null;
}

function defaultImageReadingModelForProvider(provider: string): string {
  if (isWorkersAiProvider(provider)) {
    return DEFAULT_IMAGE_READING_MODEL;
  }
  if (isOpenAiConfigProvider(provider)) {
    return "gpt-4o";
  }
  return "";
}

function defaultImageGenerationModelForProvider(provider: string): string {
  if (isWorkersAiProvider(provider)) {
    return DEFAULT_IMAGE_GENERATION_MODEL;
  }
  if (isOpenAiConfigProvider(provider)) {
    return "gpt-image-1.5";
  }
  return "";
}

function defaultTranscriptionModelForProvider(provider: string): string {
  if (isWorkersAiProvider(provider)) {
    return DEFAULT_AUDIO_TRANSCRIPTION_MODEL;
  }
  if (isOpenAiConfigProvider(provider)) {
    return DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
  }
  return "";
}

function defaultSpeechModelForProvider(provider: string): string {
  if (isWorkersAiProvider(provider)) {
    return DEFAULT_AUDIO_SPEECH_MODEL;
  }
  if (isOpenAiConfigProvider(provider)) {
    return DEFAULT_OPENAI_SPEECH_MODEL;
  }
  return "";
}

function defaultSpeechSpeakerForProvider(provider: string): string {
  if (isWorkersAiProvider(provider)) {
    return DEFAULT_AUDIO_SPEECH_SPEAKER;
  }
  if (isOpenAiConfigProvider(provider)) {
    return DEFAULT_OPENAI_SPEECH_VOICE;
  }
  return "";
}

function isOpenAiConfigProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "openai";
}

/**
 * Tool approval policy for the effective account chain, falling back to the
 * system default.
 */
function resolveAccountApprovalPolicy(config: KernelContext["config"], accountUids: readonly number[]): string | null {
  for (const uid of accountUids) {
    const value = config.get(`users/${uid}/ai/tools/approval`);
    if (value !== null) {
      return value;
    }
  }
  return config.get("config/ai/tools/approval") ?? null;
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
  const registryContextWindow = resolveModelContextWindowFromRegistry(provider, model);
  if (registryContextWindow !== null) {
    return registryContextWindow;
  }

  if (isWorkersAiProvider(provider)) {
    const workersAiContextWindow = await resolveWorkersAiModelContextWindow(model);
    if (workersAiContextWindow !== null) {
      return workersAiContextWindow;
    }
  }

  return null;
}
