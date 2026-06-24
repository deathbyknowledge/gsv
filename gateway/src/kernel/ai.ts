/**
 * ai.* syscall handlers.
 *
 * ai.tools — returns available tool schemas, online devices, and ready MCP servers accessible to caller.
 * ai.config — reads model/provider/apiKey from /sys/ (kernel SQLite via ConfigStore).
 *
 * Config resolution order:
 *   /sys/users/{run-as uid}/ai/* → /sys/users/{owner uid}/ai/* → /sys/config/ai/*
 *
 * Runtime reads are explicit SQLite overrides over code defaults.
 */

import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type {
  AiToolsResult,
  AiToolsDevice,
  AiConfigArgs,
  AiConfigResult,
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
import type { ProcAiConfigGetResult } from "../syscalls/proc";
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
import { normalizeProcessAiConfigValues } from "../process/ai-config";
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
  const processOverrides = normalizeProcessAiConfigValues(args?.processOverrides ?? {});

  const provider =
    resolveAiProcessConfigValue(processOverrides, "provider") ??
    resolveAiConfigValue(config, accountConfigUids, "provider") ??
    config.get("config/ai/provider") ??
    "workers-ai";

  const model =
    resolveAiProcessConfigValue(processOverrides, "model") ??
    resolveAiConfigValue(config, accountConfigUids, "model") ??
    config.get("config/ai/model") ??
    "@cf/nvidia/nemotron-3-120b-a12b";

  const apiKey =
    resolveAiProcessConfigValue(processOverrides, "api_key") ??
    resolveAiConfigValue(config, accountConfigUids, "api_key") ??
    config.get("config/ai/api_key") ??
    "";

  const reasoning =
    resolveAiProcessConfigValue(processOverrides, "reasoning") ??
    resolveAiConfigValue(config, accountConfigUids, "reasoning") ??
    config.get("config/ai/reasoning") ??
    undefined;

  const maxTokens = parseInt(
    resolveAiProcessConfigValue(processOverrides, "max_tokens") ??
    resolveAiConfigValue(config, accountConfigUids, "max_tokens") ??
    config.get("config/ai/max_tokens") ??
    "8192",
    10,
  );
  const contextWindowOverride = parsePositiveInt(
    resolveAiProcessConfigValue(processOverrides, "context_window_tokens") ??
    resolveAiConfigValue(config, accountConfigUids, "context_window_tokens"),
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
  // provider reads /home/<account>/context.d). Tool approval is per account
  // (keyed by the run-as uid).
  const accountApprovalPolicy = resolveAccountApprovalPolicy(config, uid);

  const maxContextBytes = parseInt(
    resolveAiProcessConfigValue(processOverrides, "max_context_bytes") ??
    resolveAiConfigValue(config, accountConfigUids, "max_context_bytes") ??
    config.get("config/ai/max_context_bytes") ??
    "32768",
    10,
  );
  const generationTimeoutMs = parsePositiveInt(
    resolveAiProcessConfigValue(processOverrides, "generation/timeout_ms"),
  ) ?? parsePositiveInt(
    resolveAiConfigValue(config, accountConfigUids, "generation/timeout_ms"),
  ) ?? parsePositiveInt(
    config.get("config/ai/generation/timeout_ms"),
  ) ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationStreaming = normalizeGenerationStreaming(
    resolveAiProcessConfigValue(processOverrides, "generation/streaming") ??
    config.get("config/ai/generation/streaming"),
  );
  const media = resolveAiMediaConfig(config, accountConfigUids, apiKey, processOverrides);
  const timezone = config.get("config/server/timezone") ?? "UTC";
  const skillIndex = await collectPromptSkillIndex(ctx).catch((error) => {
    console.warn(
      `[Prompt] failed to collect skills.d index: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  });

  return {
    owner,
    provider,
    model,
    apiKey,
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
    maxContextBytes,
    generationTimeoutMs,
    generationStreaming,
    media,
  };
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

function resolveAiConfigValue(
  config: KernelContext["config"],
  accountUids: number[],
  key: string,
): string | null {
  for (const accountUid of accountUids) {
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

async function resolveAiMediaConfigForContext(ctx: KernelContext): Promise<NonNullable<AiConfigResult["media"]>> {
  const uid = ctx.identity?.process.uid ?? 0;
  const owner = resolveOwnerIdentity(ctx);
  const accountConfigUids = resolveAiConfigAccountUids(uid, owner);
  const processOverrides = await resolveAiProcessOverridesForContext(ctx);
  const apiKey =
    resolveAiProcessConfigValue(processOverrides, "api_key") ??
    resolveAiConfigValue(ctx.config, accountConfigUids, "api_key") ??
    ctx.config.get("config/ai/api_key") ??
    "";
  return resolveAiMediaConfig(ctx.config, accountConfigUids, apiKey, processOverrides);
}

async function resolveAiProcessOverridesForContext(ctx: KernelContext): Promise<Record<string, string>> {
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
  return normalizeProcessAiConfigValues(result.config.values);
}

function resolveAiMediaConfig(
  config: KernelContext["config"],
  accountUids: number[],
  defaultApiKey: string,
  processOverrides: Record<string, string>,
): NonNullable<AiConfigResult["media"]> {
  const transcriptionProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "transcription/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, "transcription/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/transcription/provider")) ??
    "workers-ai";
  const transcriptionModel =
    resolveAiProcessConfigValue(processOverrides, "transcription/model") ??
    resolveAiConfigValue(config, accountUids, "transcription/model") ??
    getExplicitConfigValue(config, "config/ai/transcription/model") ??
    defaultTranscriptionModelForProvider(transcriptionProvider);
  const transcriptionApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "transcription/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, "transcription/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/transcription/api_key")) ??
    defaultApiKey;
  const transcriptionMaxBytes =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "transcription/max_bytes")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, "transcription/max_bytes")) ??
    parsePositiveInt(config.get("config/ai/transcription/max_bytes")) ??
    DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES;
  const imageReadingProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "image/read/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, "image/read/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/image/read/provider")) ??
    "workers-ai";
  const imageReadingModel =
    resolveAiProcessConfigValue(processOverrides, "image/read/model") ??
    resolveAiConfigValue(config, accountUids, "image/read/model") ??
    getExplicitConfigValue(config, "config/ai/image/read/model") ??
    defaultImageReadingModelForProvider(imageReadingProvider);
  const imageReadingApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "image/read/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, "image/read/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/image/read/api_key")) ??
    defaultApiKey;
  const imageReadingInputFormat =
    normalizeImageReadingInputFormat(resolveAiProcessConfigValue(processOverrides, "image/read/input_format")) ??
    normalizeImageReadingInputFormat(resolveAiConfigValue(config, accountUids, "image/read/input_format")) ??
    normalizeImageReadingInputFormat(config.get("config/ai/image/read/input_format")) ??
    DEFAULT_IMAGE_READING_INPUT_FORMAT;
  const imageReadingMaxBytes =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "image/read/max_bytes")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, "image/read/max_bytes")) ??
    parsePositiveInt(config.get("config/ai/image/read/max_bytes")) ??
    DEFAULT_MAX_IMAGE_READING_BYTES;
  const imageReadingMaxTokens =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "image/read/max_tokens")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, "image/read/max_tokens")) ??
    parsePositiveInt(config.get("config/ai/image/read/max_tokens")) ??
    DEFAULT_IMAGE_READING_MAX_TOKENS;
  const imageReadingTimeoutMs =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "image/read/timeout_ms")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, "image/read/timeout_ms")) ??
    parsePositiveInt(config.get("config/ai/image/read/timeout_ms")) ??
    DEFAULT_IMAGE_READING_TIMEOUT_MS;
  const imageReadingPrompt =
    resolveAiProcessConfigValue(processOverrides, "image/read/prompt") ??
    resolveAiConfigValue(config, accountUids, "image/read/prompt") ??
    config.get("config/ai/image/read/prompt") ??
    DEFAULT_IMAGE_READING_PROMPT;
  const imageGenerationProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "image/generation/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, "image/generation/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/image/generation/provider")) ??
    "workers-ai";
  const imageGenerationModel =
    resolveAiProcessConfigValue(processOverrides, "image/generation/model") ??
    resolveAiConfigValue(config, accountUids, "image/generation/model") ??
    getExplicitConfigValue(config, "config/ai/image/generation/model") ??
    defaultImageGenerationModelForProvider(imageGenerationProvider);
  const imageGenerationApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "image/generation/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, "image/generation/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/image/generation/api_key")) ??
    defaultApiKey;
  const speechProvider =
    normalizeProviderName(resolveAiProcessConfigValue(processOverrides, "speech/provider")) ??
    normalizeProviderName(resolveAiConfigValue(config, accountUids, "speech/provider")) ??
    normalizeProviderName(getExplicitConfigValue(config, "config/ai/speech/provider")) ??
    "workers-ai";
  const speechModel =
    resolveAiProcessConfigValue(processOverrides, "speech/model") ??
    resolveAiConfigValue(config, accountUids, "speech/model") ??
    getExplicitConfigValue(config, "config/ai/speech/model") ??
    defaultSpeechModelForProvider(speechProvider);
  const speechApiKey =
    normalizeOptionalString(resolveAiProcessConfigValue(processOverrides, "speech/api_key")) ??
    normalizeOptionalString(resolveAiConfigValue(config, accountUids, "speech/api_key")) ??
    normalizeOptionalString(getExplicitConfigValue(config, "config/ai/speech/api_key")) ??
    defaultApiKey;
  const speechSpeaker =
    resolveAiProcessConfigValue(processOverrides, "speech/speaker") ??
    resolveAiConfigValue(config, accountUids, "speech/speaker") ??
    getExplicitConfigValue(config, "config/ai/speech/speaker") ??
    defaultSpeechSpeakerForProvider(speechProvider);
  const speechEncoding =
    resolveAiProcessConfigValue(processOverrides, "speech/encoding") ??
    resolveAiConfigValue(config, accountUids, "speech/encoding") ??
    config.get("config/ai/speech/encoding") ??
    DEFAULT_AUDIO_SPEECH_ENCODING;
  const speechMaxChars =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "speech/max_chars")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, "speech/max_chars")) ??
    parsePositiveInt(config.get("config/ai/speech/max_chars")) ??
    DEFAULT_MAX_AUDIO_SPEECH_CHARS;
  const speechTimeoutMs =
    parsePositiveInt(resolveAiProcessConfigValue(processOverrides, "speech/timeout_ms")) ??
    parsePositiveInt(resolveAiConfigValue(config, accountUids, "speech/timeout_ms")) ??
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
 * Tool approval policy for an account (keyed by run-as uid), falling back to
 * the global default.
 */
function resolveAccountApprovalPolicy(config: KernelContext["config"], uid: number): string | null {
  return (
    config.get(`users/${uid}/ai/tools/approval`) ??
    config.get("config/ai/tools/approval") ??
    null
  );
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
