/**
 * ai.* syscall handlers.
 *
 * ai.tools — returns available tool schemas, online devices, and ready MCP servers accessible to caller.
 * ai.context — returns the current prompt-relevant Kernel projection without model credentials.
 * ai.config — resolves the owner's ordered model stack from /sys/.
 *
 * Config resolution order:
 *   process preference → /sys/users/{owner uid}/ai/models → /sys/config/ai/models
 *   Reasoning and runtime policy remain orthogonal account/system settings.
 *
 */

import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { FrameBody } from "../protocol/frames";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import {
  bodyFromBytes,
  bodyToBytes,
  normalizeSpeechText,
  normalizeSpeechTextFormat,
} from "@humansandmachines/gsv/protocol";
import type {
  AiModelConfig,
  AiModelEntry,
  AiModelStack,
  ProcessIdentity,
  AiContextArgs,
  AiContextResult,
  AiToolsResult,
  AiToolsTarget,
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
} from "@humansandmachines/gsv/protocol";
import type { ToolDefinition, SyscallName } from "../syscalls";
import { intoSyscallTool, isRoutableSyscall } from "../syscalls";
import { hasCapability } from "./capabilities";
import { resolveAiProviderOAuthApiKey } from "./ai-oauth";

import { FS_READ_DEFINITION } from "../syscalls/read";
import { FS_WRITE_DEFINITION } from "../syscalls/write";
import { FS_EDIT_DEFINITION } from "../syscalls/edit";
import { FS_DELETE_DEFINITION } from "../syscalls/delete";
import { FS_SEARCH_DEFINITION } from "../syscalls/search";
import { SHELL_EXEC_DEFINITION } from "../syscalls/shell";
import { CODEMODE_EXEC_DEFINITION } from "../syscalls/codemode";
import { isCodeModeAvailable } from "../codemode/availability";
import { DEFAULT_TEXT_GENERATION_MAX_TOKENS } from "../inference/default-models";
import { isWorkersAiProvider, resolveWorkersAiModelContextWindow } from "../inference/workers-ai";
import { resolveModelContextWindowFromRegistry } from "../inference/model-registry";
import {
  createGenerationService,
  extractGeneratedText,
} from "../inference/service";
import {
  gsvInferenceProviderFactoryFromEnv,
} from "../inference/gsv-provider";
import {
  inferenceLogicalRequestId,
  type InferenceAttribution,
} from "../inference/provider";
import { createRoutedFetch, normalizeTarget, type NetFetchDeviceTransport } from "./net";
import {
  DEFAULT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
  DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES,
} from "../inference/transcription";
import { encodeBase64Bytes } from "../shared/base64";
import {
  DEFAULT_IMAGE_READING_MAX_OBJECTS,
  DEFAULT_IMAGE_READING_MAX_TOKENS,
  DEFAULT_IMAGE_READING_TIMEOUT_MS,
  DEFAULT_MAX_IMAGE_READING_BYTES,
  readImage,
} from "../inference/image-reading";
import {
  DEFAULT_AUDIO_SPEECH_ENCODING,
  DEFAULT_AUDIO_SPEECH_TIMEOUT_MS,
  DEFAULT_MAX_AUDIO_SPEECH_CHARS,
} from "../inference/speech";
import {
  generateImage,
  synthesizeSpeech,
  transcribeAudio,
} from "../inference/capabilities";
import { isVectorImageMimeType } from "../inference/image-mime";
import { RipgitClient } from "../fs";
import { collectPromptSkillIndex } from "./skills";
import { seedBuiltinSkillsToHome } from "./sys/skills-seed";
import { listAllVisibleTargets, targetToAiTarget } from "./targets";
import {
  aiModelApiKeyConfigKey,
  isSameAiModelCredentialScope,
  orderAiModelStack,
  parseAiModelStack,
  SYSTEM_AI_MODELS_CONFIG_KEY,
  userAiModelsConfigKey,
} from "./ai-model-stack";

const SYSCALL_TOOLS: Array<{ syscall: SyscallName; definition: ToolDefinition }> = [
  { syscall: "fs.read", definition: FS_READ_DEFINITION },
  { syscall: "fs.write", definition: FS_WRITE_DEFINITION },
  { syscall: "fs.edit", definition: FS_EDIT_DEFINITION },
  { syscall: "fs.delete", definition: FS_DELETE_DEFINITION },
  { syscall: "fs.search", definition: FS_SEARCH_DEFINITION },
  { syscall: "shell.exec", definition: SHELL_EXEC_DEFINITION },
  { syscall: "codemode.exec", definition: CODEMODE_EXEC_DEFINITION },
];

const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const DEFAULT_GENERATION_STREAMING = "auto";

type AiFrameResult<T> = { data: T; body?: FrameBody };
type AiModelStackConfig = Pick<
  AiConfigResult,
  | "provider"
  | "model"
  | "apiKey"
  | "baseUrl"
  | "providerStyle"
  | "transportTarget"
  | "openAiCodex"
  | "reasoning"
  | "maxTokens"
  | "contextWindowTokens"
  | "contextWindowSource"
  | "generationTimeoutMs"
  | "generationStreaming"
>;

type StoredAiModelStack = {
  configKey: string;
  stack: AiModelStack;
  systemOwned: boolean;
};

type ResolvedAiTextModelStack = {
  primary: AiModelStackConfig;
  fallbacks: AiConfigFallback[];
};

type AiMediaModelConfig = {
  provider: string;
  model: string;
  apiKey: string;
  values: Readonly<Record<string, string>>;
};

export async function handleAiTools(
  ctx: KernelContext,
): Promise<AiToolsResult> {
  const identity = ctx.identity!;
  const capabilities = identity.capabilities;
  const canUseMcpTools = hasCapability(capabilities, "sys.mcp.list")
    && hasCapability(capabilities, "sys.mcp.call");
  const mcpUid = resolveCallerOwnerUid(ctx);

  const visibleTargets = await listAllVisibleTargets(ctx);
  const onlineDevices: AiToolsTarget[] = visibleTargets.map(targetToAiTarget);

  const tools: ToolDefinition[] = [];

  for (const { syscall, definition } of SYSCALL_TOOLS) {
    if (!hasCapability(capabilities, syscall)) continue;
    if (syscall === "codemode.exec" && !isCodeModeAvailable(ctx.env)) continue;

    if (isRoutableSyscall(syscall)) {
      tools.push(intoSyscallTool(definition));
    } else {
      tools.push(definition);
    }
  }

  return {
    tools,
    targets: onlineDevices,
    mcpServers: canUseMcpTools ? listReadyMcpServerNames(ctx, mcpUid) : [],
  };
}

export async function handleAiContext(
  _args: AiContextArgs,
  ctx: KernelContext,
): Promise<AiContextResult> {
  const config = ctx.config;
  const uid = ctx.identity?.process.uid ?? 0;
  const owner = resolveOwnerIdentity(ctx);
  const accountConfigUids = resolveAiConfigAccountUids(uid, owner);
  const resolveConfig = createAiConfigValueResolver(config, accountConfigUids);
  const skillIndexMode = normalizeSkillIndexMode(resolveConfig("skills/index_mode"));
  const skillIndex = skillIndexMode === "off"
    ? []
    : await collectPromptSkillIndex(ctx).catch((error) => {
        console.warn(
          `[Prompt] failed to refresh skills.d index: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
  const canUseMcpTools = hasCapability(ctx.identity?.capabilities ?? [], "sys.mcp.list")
    && hasCapability(ctx.identity?.capabilities ?? [], "sys.mcp.call");
  const mcpUid = resolveCallerOwnerUid(ctx);

  const result: AiContextResult = {
    targets: (await listAllVisibleTargets(ctx)).map(targetToAiTarget),
    mcpServers: canUseMcpTools ? listReadyMcpServerNames(ctx, mcpUid) : [],
    systemContextFiles: listConfigContextFiles(config, "config/ai/context.d"),
    system: {
      timezone: config.get("config/server/timezone") ?? "UTC",
    },
    skillIndexMode,
  };
  if (skillIndex !== undefined) result.skillIndex = skillIndex;
  return result;
}

export async function handleAiConfig(
  args: AiConfigArgs,
  ctx: KernelContext,
): Promise<AiConfigResult> {
  const config = ctx.config;
  const uid = ctx.identity?.process.uid ?? 0;
  const owner = resolveOwnerIdentity(ctx);
  const builtinSkillsReady = ensureBuiltinSkillsForPrompt(ctx, owner);
  const accountConfigUids = resolveAiConfigAccountUids(uid, owner);
  const input = args;
  const resolveConfig = createAiConfigValueResolver(config, accountConfigUids);
  const textModels = await resolveAiTextModelStack({
    ctx,
    uid,
    owner,
    accountUids: accountConfigUids,
    modelConfig: input.modelConfig,
    modelId: input.modelId,
    reasoning: input.reasoning,
  });
  const primary = textModels.primary;

  const systemContextFiles = listConfigContextFiles(config, "config/ai/context.d");

  // Persona and context come from the run-as account's home (the home.context
  // provider reads /home/<account>/context.d). Tool approval follows the same
  // account default order as model config, so humans can own defaults for their
  // agents while agents can still override them.
  const accountApprovalPolicy = resolveAccountApprovalPolicy(config, accountConfigUids);

  const maxContextBytes = parseInt(
    resolveConfig("max_context_bytes") ?? "32768",
    10,
  );
  const media = resolveAiMediaConfig(
    config,
    accountConfigUids,
  );
  const timezone = config.get("config/server/timezone") ?? "UTC";
  await builtinSkillsReady;
  const skillIndexMode = normalizeSkillIndexMode(resolveConfig("skills/index_mode"));
  const skillIndex = skillIndexMode === "off"
    ? []
    : await collectPromptSkillIndex(ctx).catch((error) => {
      console.warn(
        `[Prompt] failed to collect skills.d index: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    });

  const result: AiConfigResult = {
    owner,
    executor: resolveAiTextExecutor(ctx),
    provider: primary.provider,
    model: primary.model,
    apiKey: primary.apiKey,
    providerStyle: primary.providerStyle,
    transportTarget: primary.transportTarget,
    reasoning: primary.reasoning,
    maxTokens: primary.maxTokens,
    contextWindowTokens: primary.contextWindowTokens,
    contextWindowSource: primary.contextWindowSource,
    systemContextFiles,
    system: {
      timezone,
    },
    skillIndex,
    skillIndexMode,
    accountApprovalPolicy,
    capabilities: [...(ctx.identity?.capabilities ?? [])],
    maxContextBytes,
    generationTimeoutMs: primary.generationTimeoutMs,
    generationStreaming: primary.generationStreaming,
    media,
  };
  if (primary.baseUrl) result.baseUrl = primary.baseUrl;
  if (primary.openAiCodex) result.openAiCodex = primary.openAiCodex;
  if (textModels.fallbacks.length > 0) result.fallbacks = textModels.fallbacks;
  return result;
}

async function ensureBuiltinSkillsForPrompt(
  ctx: KernelContext,
  owner: ProcessIdentity | null,
): Promise<void> {
  const identity = owner ?? ctx.identity?.process;
  if (!ctx.env.RIPGIT || !identity) {
    return;
  }

  try {
    await seedBuiltinSkillsToHome(new RipgitClient(ctx.env.RIPGIT), identity);
  } catch (error) {
    console.warn(
      `[Prompt] failed to reconcile built-in skills: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleAiTextGenerate(
  args: AiTextGenerateArgs,
  ctx: KernelContext,
  transport?: NetFetchDeviceTransport,
): Promise<AiTextGenerateResult> {
  const input = args;
  const target = normalizeOptionalString(input.target) ?? "gsv";
  if (target !== "gsv") {
    // TODO: implement device ai gen + routing.
    throw new Error(`AI text generation target is not available: ${target}`);
  }

  const config = await resolveAiTextGenerationConfig(input.config, ctx);
  const context = normalizeAiTextGenerationContext(input);
  const options = normalizeAiTextGenerateOptions(input.options);
  const transportTarget = normalizeTarget(config.transportTarget);
  const generationFetch = transportTarget === "gsv"
    ? undefined
    : createRoutedFetch(ctx, transport, transportTarget);
  const gsvInference = gsvInferenceProviderFactoryFromEnv(ctx.env);
  const attribution = await inferenceAttribution(ctx);
  const serviceOptions: Parameters<typeof createGenerationService>[0] = {};
  if (generationFetch) serviceOptions.fetch = generationFetch;
  if (gsvInference) serviceOptions.providers = [gsvInference];
  const generationRequest: Parameters<ReturnType<typeof createGenerationService>["generate"]>[0] = {
    config,
    context,
    sessionAffinityKey: normalizeOptionalString(input.sessionAffinityKey),
    signal: ctx.requestSignal,
    attribution,
  };
  if (options) generationRequest.options = options;
  const response = await createGenerationService(serviceOptions).generate(generationRequest);
  const text = extractGeneratedText(response);
  // SAFETY: The generation service and public AI protocol share the assistant-message contract.
  const message = response as AiAssistantMessage;
  const result: AiTextGenerateResult = {
    message,
    provider: response.provider || config.provider,
    model: response.model || config.model,
  };
  if (text) result.text = text;
  return result;
}

async function inferenceAttribution(
  ctx: KernelContext,
): Promise<InferenceAttribution> {
  const process = ctx.identity?.process;
  const attribution: InferenceAttribution = {
    installationId: ctx.installationId,
    logicalRequestId: await inferenceLogicalRequestId([
      "kernel",
      ctx.installationId,
      process?.uid ?? 0,
      ctx.processId,
      ctx.processRunId,
      ctx.requestId ?? crypto.randomUUID(),
    ]),
    actor: {
      localUid: process?.uid ?? 0,
    },
    workload: "kernel",
  };
  if (ctx.processId) attribution.actor.processId = ctx.processId;
  if (ctx.processRunId) attribution.actor.runId = ctx.processRunId;
  return attribution;
}

async function readAiInputBody(
  body: FrameBody | undefined,
  maxBytes: number,
  label: "audio" | "image",
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!body) {
    throw new Error(`${label} request body is required`);
  }

  const bytes = await bodyToBytes(body, maxBytes, signal);
  if (bytes.byteLength === 0) {
    throw new Error(`${label} request body is empty`);
  }
  return bytes;
}

export async function handleAiTranscriptionCreate(
  args: AiTranscriptionCreateArgs,
  ctx: KernelContext,
  body?: FrameBody,
): Promise<AiTranscriptionCreateResult> {
  const input = args;
  const configContext = resolveAiTranscriptionProcessContext(input.pid, ctx);
  const media = resolveAiMediaConfigForContext(configContext);
  const audio = input.audio;
  if (!audio.mimeType.trim().toLowerCase().startsWith("audio/")) {
    throw new Error("audio.mimeType must be an audio MIME type");
  }

  const bytes = await readAiInputBody(body, media.transcriptionMaxBytes, "audio", ctx.requestSignal);
  const base64 = encodeBase64Bytes(bytes);

  const mode = input.mode === "translate" ? "translate" : "transcribe";
  const result = await transcribeAudio({
    workersAi: ctx.env.AI,
  }, {
    data: base64,
    provider: media.transcriptionProvider,
    apiKey: media.transcriptionApiKey,
    model: media.transcriptionModel,
    mimeType: audio.mimeType,
    filename: audio.filename,
    timeoutMs: DEFAULT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
    signal: ctx.requestSignal,
    mode,
    language: normalizeOptionalString(input.language),
    prompt: normalizeOptionalString(input.prompt),
    vadFilter: true,
    conditionOnPreviousText: false,
  });
  if (result) {
    return result;
  }
  throw new Error("Transcription unavailable");
}

export async function handleAiImageRead(
  args: AiImageReadArgs,
  ctx: KernelContext,
  body?: FrameBody,
): Promise<AiFrameResult<AiImageReadResult>> {
  const input = args;
  const media = resolveAiMediaConfigForContext(ctx);
  const image = input.image;
  if (!image.mimeType.trim().toLowerCase().startsWith("image/")) {
    throw new Error("image.mimeType must be an image MIME type");
  }
  if (isVectorImageMimeType(image.mimeType)) {
    throw new Error("SVG image reading requires rasterization");
  }

  const bytes = await readAiInputBody(body, media.imageReadingMaxBytes, "image", ctx.requestSignal);
  const base64 = encodeBase64Bytes(bytes);
  const mode = input.mode ?? "caption";

  const response = await readImage(ctx.env.AI, {
    data: base64,
    mimeType: image.mimeType,
    mode,
    prompt: "prompt" in input ? normalizeOptionalString(input.prompt) : undefined,
    target: "target" in input ? normalizeOptionalString(input.target) : undefined,
    captionLength: "captionLength" in input ? input.captionLength : undefined,
    reasoning: "reasoning" in input ? input.reasoning : undefined,
    responseFormat: "responseFormat" in input ? input.responseFormat : undefined,
    schema: "schema" in input ? input.schema : undefined,
    stream: "stream" in input ? input.stream : undefined,
    maxTokens: mode === "caption" || mode === "query" || mode === "ocr"
      ? ("maxTokens" in input && input.maxTokens !== undefined
        ? input.maxTokens
        : media.imageReadingMaxTokens)
      : undefined,
    maxObjects: input.mode === "point" || input.mode === "detect"
      ? input.maxObjects ?? media.imageReadingMaxObjects
      : undefined,
    temperature: "temperature" in input ? input.temperature : undefined,
    topP: "topP" in input ? input.topP : undefined,
    timeoutMs: media.imageReadingTimeoutMs,
    signal: ctx.requestSignal,
  });
  if (!response) {
    throw new Error("Image reading unavailable");
  }

  const result: AiFrameResult<AiImageReadResult> = { data: response.result };
  if (response.stream) result.body = { stream: response.stream };
  return result;
}

export async function handleAiImageGenerate(
  args: AiImageGenerateArgs,
  ctx: KernelContext,
): Promise<AiFrameResult<AiImageGenerateResult>> {
  const input = args;
  const media = resolveAiMediaConfigForContext(ctx);
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

  const data: AiImageGenerateResult = {
      image: {
        mimeType: result.mimeType,
        size: result.bytes?.byteLength ?? 0,
      },
      provider: result.provider,
      model: result.model,
  };
  if (result.revisedPrompt) data.revisedPrompt = result.revisedPrompt;
  if (result.url) data.url = result.url;
  const response: AiFrameResult<AiImageGenerateResult> = { data };
  if (result.bytes) response.body = bodyFromBytes(result.bytes);
  return response;
}

export async function handleAiSpeechCreate(
  args: AiSpeechCreateArgs,
  ctx: KernelContext,
): Promise<AiFrameResult<AiSpeechCreateResult>> {
  const input = args;
  const media = resolveAiMediaConfigForContext(ctx);
  const rawText = normalizeOptionalString(input.text);
  if (!rawText) {
    throw new Error("text is required");
  }
  const text = normalizeSpeechText(rawText, normalizeSpeechTextFormat(input.textFormat));
  if (!text) {
    return {
      data: {
        audio: {
          mimeType: "",
          size: 0,
        },
        provider: "none",
        model: "none",
        skipped: true,
      },
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

  const data: AiSpeechCreateResult = {
      audio: {
        mimeType: result.mimeType,
        size: result.bytes.byteLength,
      },
      provider: result.provider,
      model: result.model,
  };
  if (result.voice) data.voice = result.voice;
  if (result.encoding) data.encoding = result.encoding;
  if (result.container) data.container = result.container;
  return { data, body: bodyFromBytes(result.bytes) };
}

async function resolveAiTextGenerationConfig(
  input: AiTextGenerateConfig | undefined,
  ctx: KernelContext,
): Promise<AiConfigResult> {
  return withAiTextExecutor(
    await handleAiConfig({
      ...(input?.modelConfig ? { modelConfig: input.modelConfig } : undefined),
      ...(input?.modelId ? { modelId: input.modelId } : undefined),
      ...(input?.reasoning ? { reasoning: input.reasoning } : undefined),
    }, ctx),
    { kind: "kernel" },
  );
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
  const tools = input.tools?.map(normalizeAiTextTool);
  const context: Context = {
    systemPrompt: input.systemPrompt ?? "",
    messages: input.messages.map(normalizeAiTextMessage),
  };
  if (tools && tools.length > 0) context.tools = tools;
  return context;
}

function normalizeAiTextMessage(message: AiTextMessage): Message {
  const timestamp = normalizeTimestamp(message.timestamp);
  const normalized = { ...message, timestamp };
  // SAFETY: The generated syscall schema validates the shared pi-ai message contract.
  return normalized as Message;
}

function normalizeAiTextTool(tool: AiTextTool, index: number): Tool {
  const name = normalizeOptionalString(tool.name);
  if (!name) {
    throw new Error(`tools[${index}].name is required`);
  }
  return {
    name,
    description: tool.description,
    // SAFETY: The wire contract validates tool.parameters as a JSON Schema object.
    parameters: tool.parameters as Tool["parameters"],
  };
}

function normalizeAiTextGenerateOptions(
  input: AiTextGenerateOptions | undefined,
): AiTextGenerateOptions | undefined {
  if (!input) {
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
  value: AiTextGenerateOptions["reasoning"],
): AiTextGenerateOptions["reasoning"] | undefined {
  if (!value) {
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

function normalizeTimestamp(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
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

function withRootAiCredentialScope(accountUids: number[]): number[] {
  return accountUids.includes(0) ? accountUids : [0, ...accountUids];
}

function resolveAiConfigValue(
  config: KernelContext["config"],
  accountUids: readonly number[],
  key: string,
): string | null {
  for (const accountUid of accountUids) {
    const value = config.getExplicit(`users/${accountUid}/ai/${key}`);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function createAiConfigValueResolver(
  config: KernelContext["config"],
  accountUids: readonly number[],
) {
  function resolve(key: string): string | null;
  function resolve<T>(key: string, normalize: (value: string | null) => T | null): T | null;
  function resolve<T>(
    key: string,
    normalize?: (value: string | null) => T | null,
  ): string | T | null {
    const candidates = [
      resolveAiConfigValue(config, accountUids, key),
      config.get(`config/ai/${key}`),
    ];
    if (!normalize) {
      return candidates.find((candidate) => candidate !== null) ?? null;
    }
    for (const candidate of candidates) {
      const value = normalize(candidate);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  }
  return resolve;
}

async function resolveAiTextModelStack(options: {
  ctx: KernelContext;
  uid: number;
  owner: ProcessIdentity | null;
  accountUids: number[];
  modelConfig: AiConfigArgs["modelConfig"];
  modelId: string | null | undefined;
  reasoning: string | null | undefined;
}): Promise<ResolvedAiTextModelStack> {
  const stored = resolveStoredAiModelStack(
    options.ctx,
    resolveAiModelOwnerUid(options.ctx, options.uid, options.owner),
  );
  if (options.modelConfig) {
    return await resolveRequestAiModelConfig({
      ...options,
      modelConfig: options.modelConfig,
    }, stored);
  }
  return await resolveStoredAiTextModelStack(options, stored);
}

function resolveStoredAiModelStack(
  ctx: KernelContext,
  ownerUid: number,
): StoredAiModelStack {
  const ownerKey = userAiModelsConfigKey(ownerUid);
  const ownerRaw = ctx.config.getExplicit(ownerKey);
  if (ownerRaw !== null) {
    return parseStoredAiModelStack(ownerKey, ownerRaw, false);
  }

  const systemRaw = ctx.config.get(SYSTEM_AI_MODELS_CONFIG_KEY);
  if (systemRaw === null) {
    throw new Error("AI model stack is not configured");
  }
  return parseStoredAiModelStack(SYSTEM_AI_MODELS_CONFIG_KEY, systemRaw, true);
}

function parseStoredAiModelStack(
  configKey: string,
  raw: string,
  systemOwned: boolean,
): StoredAiModelStack {
  const stack = parseAiModelStack(raw);
  if (!stack) {
    throw new Error(`Invalid AI model stack at /sys/${configKey}`);
  }
  return { configKey, stack, systemOwned };
}

async function resolveStoredAiTextModelStack(
  options: {
    ctx: KernelContext;
    uid: number;
    accountUids: number[];
    modelId: string | null | undefined;
    reasoning: string | null | undefined;
  },
  stored: StoredAiModelStack,
): Promise<ResolvedAiTextModelStack> {
  const resolveConfig = createAiConfigValueResolver(options.ctx.config, options.accountUids);
  const requestedModelId = normalizeOptionalString(options.modelId);
  if (
    requestedModelId &&
    !stored.stack.models.some((entry) => entry.id.toLowerCase() === requestedModelId.toLowerCase())
  ) {
    throw new Error(`AI model not found: ${requestedModelId}`);
  }
  const preferredModelId = requestedModelId
    ?? normalizeOptionalString(options.ctx.config.getExplicit(`users/${options.uid}/ai/preferred_model`));
  const models = orderAiModelStack(stored.stack, preferredModelId);
  const reasoning = normalizeOptionalString(options.reasoning)
    ?? normalizeOptionalString(resolveConfig("reasoning"));
  const generationTimeoutMs = resolveConfig("generation/timeout_ms", parsePositiveInt)
    ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationStreaming = normalizeGenerationStreaming(
    resolveConfig("generation/streaming"),
  );
  const resolved: Array<{ entry: AiModelEntry; config: AiModelStackConfig }> = [];
  for (const entry of models) {
    const config = await resolveCompleteAiModelConfig({
      ctx: options.ctx,
      accountUids: options.accountUids,
      model: entry,
      apiKey: options.ctx.config.get(aiModelApiKeyConfigKey(stored.configKey, entry.id)) ?? "",
      systemOwned: stored.systemOwned,
      reasoning,
      generationTimeoutMs,
      generationStreaming,
    });
    if (!resolved.some((candidate) => isSameAiModelStack(candidate.config, config))) {
      resolved.push({ entry, config });
    }
  }

  const [primary, ...fallbacks] = resolved;
  if (!primary) {
    throw new Error(`AI model stack at /sys/${stored.configKey} has no usable models`);
  }
  return {
    primary: primary.config,
    fallbacks: fallbacks.map(({ entry, config }) => ({
      modelId: entry.id,
      modelName: entry.name,
      ...config,
    })),
  };
}

async function resolveRequestAiModelConfig(
  options: {
    ctx: KernelContext;
    uid: number;
    accountUids: number[];
    modelConfig: NonNullable<AiConfigArgs["modelConfig"]>;
    modelId: string | null | undefined;
    reasoning: string | null | undefined;
  },
  stored: StoredAiModelStack,
): Promise<ResolvedAiTextModelStack> {
  const provider = normalizeOptionalString(options.modelConfig.provider);
  const modelName = normalizeOptionalString(options.modelConfig.model);
  if (!provider || !modelName) {
    throw new Error("modelConfig.provider and modelConfig.model are required");
  }
  const modelId = normalizeOptionalString(options.modelId);
  const storedEntry = modelId
    ? stored.stack.models.find((entry) => entry.id.toLowerCase() === modelId.toLowerCase())
    : undefined;
  if (modelId && !storedEntry) {
    throw new Error(`AI model not found: ${modelId}`);
  }
  const resolveConfig = createAiConfigValueResolver(options.ctx.config, options.accountUids);
  const usesStoredCredential = options.modelConfig.apiKey === undefined &&
    storedEntry !== undefined &&
    isSameAiModelCredentialScope(storedEntry, options.modelConfig);
  const apiKey = options.modelConfig.apiKey !== undefined
    ? options.modelConfig.apiKey.trim()
    : usesStoredCredential
      ? options.ctx.config.get(aiModelApiKeyConfigKey(stored.configKey, storedEntry.id)) ?? ""
      : "";
  const config = await resolveCompleteAiModelConfig({
    ctx: options.ctx,
    accountUids: options.accountUids,
    model: {
      ...options.modelConfig,
      provider,
      model: modelName,
    },
    apiKey,
    systemOwned: usesStoredCredential ? stored.systemOwned : false,
    reasoning: normalizeOptionalString(options.reasoning)
      ?? normalizeOptionalString(resolveConfig("reasoning")),
    generationTimeoutMs: resolveConfig("generation/timeout_ms", parsePositiveInt)
      ?? DEFAULT_GENERATION_TIMEOUT_MS,
    generationStreaming: normalizeGenerationStreaming(resolveConfig("generation/streaming")),
  });
  return { primary: config, fallbacks: [] };
}

async function resolveCompleteAiModelConfig(options: {
  ctx: KernelContext;
  accountUids: number[];
  model: Omit<AiModelConfig, "apiKey">;
  apiKey: string;
  systemOwned: boolean;
  reasoning: string | undefined;
  generationTimeoutMs: number;
  generationStreaming: "auto" | "off";
}): Promise<AiModelStackConfig> {
  const provider = options.model.provider.trim();
  const model = options.model.model.trim();
  const oauth = await resolveAiProviderOAuthApiKey(
    options.ctx,
    options.systemOwned ? withRootAiCredentialScope(options.accountUids) : options.accountUids,
    provider,
    options.apiKey,
  );
  const modelContextWindow = await resolveModelContextWindow(provider, model);
  const contextWindowTokens = options.model.contextWindowTokens
    ?? modelContextWindow
    ?? null;
  const contextWindowSource = options.model.contextWindowTokens !== undefined
    ? "config" as const
    : modelContextWindow !== null
      ? "model" as const
      : "unknown" as const;
  const result: AiModelStackConfig = {
    provider,
    model,
    apiKey: oauth.apiKey,
    providerStyle: options.model.providerStyle?.trim().toLowerCase() || "auto",
    transportTarget: normalizeTarget(options.model.transportTarget ?? "gsv"),
    reasoning: options.reasoning,
    maxTokens: options.model.maxTokens ?? DEFAULT_TEXT_GENERATION_MAX_TOKENS,
    contextWindowTokens,
    contextWindowSource,
    generationTimeoutMs: options.generationTimeoutMs,
    generationStreaming: options.generationStreaming,
  };
  const baseUrl = options.model.baseUrl?.trim();
  if (baseUrl) result.baseUrl = baseUrl;
  if (oauth.openAiCodexAccountId) {
    result.openAiCodex = { accountId: oauth.openAiCodexAccountId };
  }
  return result;
}

function isSameAiModelStack(
  left: AiModelStackConfig,
  right: AiModelStackConfig,
): boolean {
  return left.provider.trim().toLowerCase() === right.provider.trim().toLowerCase() &&
    left.model.trim().toLowerCase() === right.model.trim().toLowerCase() &&
    left.apiKey === right.apiKey &&
    (left.baseUrl ?? "").trim() === (right.baseUrl ?? "").trim() &&
    (left.providerStyle ?? "auto").trim().toLowerCase() === (right.providerStyle ?? "auto").trim().toLowerCase() &&
    normalizeTarget(left.transportTarget) === normalizeTarget(right.transportTarget) &&
    (left.openAiCodex?.accountId ?? "") === (right.openAiCodex?.accountId ?? "");
}

function resolveAiTranscriptionProcessContext(
  requestedPid: string | undefined,
  ctx: KernelContext,
): KernelContext {
  if (requestedPid === undefined) {
    return ctx;
  }
  const pid = normalizeOptionalString(requestedPid);
  if (!pid) {
    throw new Error("pid must be a non-empty string");
  }
  const process = ctx.procs.get(pid);
  if (!process) {
    throw new Error(`Process not found: ${pid}`);
  }
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  if (process.ownerUid !== callerOwnerUid && ctx.identity!.process.uid !== 0) {
    throw new Error(`Permission denied: cannot access process ${pid}`);
  }
  return {
    ...ctx,
    processId: pid,
    identity: {
      ...ctx.identity!,
      process: {
        uid: process.uid,
        gid: process.gid,
        gids: process.gids,
        username: process.username,
        home: process.home,
        cwd: process.cwd,
      },
    },
  };
}

function resolveAiMediaConfigForContext(ctx: KernelContext): NonNullable<AiConfigResult["media"]> {
  const uid = ctx.identity?.process.uid ?? 0;
  const owner = resolveOwnerIdentity(ctx);
  return resolveAiMediaConfig(ctx.config, resolveAiConfigAccountUids(uid, owner));
}

function resolveAiModelOwnerUid(
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

function resolveAiMediaConfig(
  config: KernelContext["config"],
  accountUids: readonly number[],
): NonNullable<AiConfigResult["media"]> {
  const resolveConfig = createAiConfigValueResolver(config, accountUids);
  const transcription = resolveAiMediaModelConfig(config, accountUids, "transcription");
  const transcriptionMaxBytes = resolveConfig("transcription/max_bytes", parsePositiveInt)
    ?? DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES;
  const imageReadingMaxBytes = resolveConfig("image/read/max_bytes", parsePositiveInt)
    ?? DEFAULT_MAX_IMAGE_READING_BYTES;
  const imageReadingMaxTokens = resolveConfig("image/read/max_tokens", parsePositiveInt)
    ?? DEFAULT_IMAGE_READING_MAX_TOKENS;
  const imageReadingMaxObjects = resolveConfig("image/read/max_objects", parsePositiveInt)
    ?? DEFAULT_IMAGE_READING_MAX_OBJECTS;
  const imageReadingTimeoutMs = resolveConfig("image/read/timeout_ms", parsePositiveInt)
    ?? DEFAULT_IMAGE_READING_TIMEOUT_MS;
  const imageGeneration = resolveAiMediaModelConfig(config, accountUids, "image/generation");
  const speech = resolveAiMediaModelConfig(config, accountUids, "speech", ["speaker"]);
  const speechSpeaker = speech.values.speaker ?? "";
  const speechEncoding = resolveConfig("speech/encoding") ?? DEFAULT_AUDIO_SPEECH_ENCODING;
  const speechMaxChars = resolveConfig("speech/max_chars", parsePositiveInt)
    ?? DEFAULT_MAX_AUDIO_SPEECH_CHARS;
  const speechTimeoutMs = resolveConfig("speech/timeout_ms", parsePositiveInt)
    ?? DEFAULT_AUDIO_SPEECH_TIMEOUT_MS;

  return {
    transcriptionProvider: transcription.provider,
    transcriptionModel: transcription.model,
    transcriptionApiKey: transcription.apiKey,
    transcriptionMaxBytes,
    imageReadingMaxBytes,
    imageReadingMaxTokens,
    imageReadingMaxObjects,
    imageReadingTimeoutMs,
    imageGenerationProvider: imageGeneration.provider,
    imageGenerationModel: imageGeneration.model,
    imageGenerationApiKey: imageGeneration.apiKey,
    speechProvider: speech.provider,
    speechModel: speech.model,
    speechApiKey: speech.apiKey,
    speechSpeaker,
    speechEncoding,
    speechMaxChars,
    speechTimeoutMs,
  };
}

function resolveAiMediaModelConfig(
  config: KernelContext["config"],
  accountUids: readonly number[],
  key: "transcription" | "image/generation" | "speech",
  extraKeys: readonly string[] = [],
): AiMediaModelConfig {
  const fieldNames = ["provider", "model", "api_key", ...extraKeys];
  for (const uid of accountUids) {
    const prefix = `users/${uid}/ai/${key}`;
    const values = Object.fromEntries(fieldNames.flatMap((field) => {
      const value = config.getExplicit(`${prefix}/${field}`);
      return value === null ? [] : [[field, value]];
    }));
    if (Object.keys(values).length > 0) {
      return requireCompleteAiMediaModelConfig(prefix, values);
    }
  }

  const prefix = `config/ai/${key}`;
  const explicitValues = Object.fromEntries(fieldNames.flatMap((field) => {
    const value = config.getExplicit(`${prefix}/${field}`);
    return value === null ? [] : [[field, value]];
  }));
  if (Object.keys(explicitValues).length > 0) {
    return requireCompleteAiMediaModelConfig(prefix, explicitValues);
  }
  const values = Object.fromEntries(fieldNames.flatMap((field) => {
    const value = config.get(`${prefix}/${field}`);
    return value === null ? [] : [[field, value]];
  }));
  return requireCompleteAiMediaModelConfig(prefix, values);
}

function requireCompleteAiMediaModelConfig(
  prefix: string,
  values: Readonly<Record<string, string>>,
): AiMediaModelConfig {
  const provider = values.provider?.trim().toLowerCase();
  const model = values.model?.trim();
  if (!provider || !model) {
    throw new Error(`AI model configuration at /sys/${prefix} must include provider and model`);
  }
  return {
    provider,
    model,
    apiKey: values.api_key?.trim() ?? "",
    values,
  };
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

function normalizeSkillIndexMode(value: string | null | undefined): "summary" | "names" | "off" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "names" || normalized === "off" ? normalized : "summary";
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePositiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function listReadyMcpServerNames(ctx: KernelContext, uid: number): string[] {
  const names = new Set<string>();
  for (const record of ctx.mcpServers.list(uid)) {
    const connection = ctx.mcp.mcpConnections[record.serverId];
    if (connection?.connectionState === "ready") {
      names.add(record.name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
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
