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
import type { FrameBody } from "../protocol/frames";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import {
  bodyFromBytes,
  bodyToBytes,
  normalizeSpeechText,
  normalizeSpeechTextFormat,
} from "@humansandmachines/gsv/protocol";
import type {
  ProcessIdentity,
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
  ProcAiConfigGetResult,
  ProcAiConfigProfileRef,
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
import {
  DEFAULT_WORKERS_AI_MODEL,
  isWorkersAiProvider,
  resolveWorkersAiModelContextWindow,
} from "../inference/workers-ai";
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
  DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
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
import { isVectorImageMimeType } from "../inference/image-mime";
import { RipgitClient } from "../fs";
import { collectPromptSkillIndex } from "./skills";
import { seedBuiltinSkillsToHome } from "./sys/skills-seed";
import { listVisibleTargets, targetToAiDevice } from "./targets";
import {
  findProcessAiModelProfile,
  isProcessAiConfigKey,
  omitProcessAiConfigSecrets,
  parseProcessAiModelProfiles,
  PROCESS_AI_CONFIG_SECRET_KEYS,
  processAiModelProfileSecretConfigKey,
} from "../process/ai-config";
import { raceWithAbort } from "../shared/abort";
import { sendFrameToProcess } from "../shared/utils";

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

type AiAccountProfileOverrides = Map<number, Record<string, string>>;
interface AiConfigValues {
  [key: string]: string;
}
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

type AiTranscriptionStack = Pick<
  NonNullable<AiConfigResult["media"]>,
  "transcriptionProvider" | "transcriptionModel" | "transcriptionApiKey"
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

  const visibleTargets = listVisibleTargets(ctx);
  const onlineDevices: AiToolsDevice[] = visibleTargets.map(targetToAiDevice);
  const deviceIds = visibleTargets.map((target) => target.targetId);

  const tools: ToolDefinition[] = [];

  for (const { syscall, definition } of SYSCALL_TOOLS) {
    if (!hasCapability(capabilities, syscall)) continue;
    if (syscall === "codemode.exec" && !isCodeModeAvailable(ctx.env)) continue;

    if (isRoutableSyscall(syscall)) {
      tools.push(intoSyscallTool(definition, deviceIds));
    } else {
      tools.push(definition);
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
  const builtinSkillsReady = ensureBuiltinSkillsForPrompt(ctx, owner);
  const accountConfigUids = resolveAiConfigAccountUids(uid, owner);
  const input = args;
  const processOverrides = resolveEffectiveAiProcessOverrides(
    ctx,
    uid,
    owner,
    input.processOverrides,
    input.processProfile,
  );
  const accountProfileOverrides = resolveAiAccountProfileOverrides(config, accountConfigUids);
  const resolveConfig = createAiConfigValueResolver(
    config,
    accountConfigUids,
    accountProfileOverrides,
    processOverrides,
  );
  const processProvider = resolveAiProcessConfigValue(processOverrides, "provider");
  const accountProvider = resolveAiConfigValue(config, accountConfigUids, accountProfileOverrides, "provider");
  const systemProvider = config.get("config/ai/provider");

  const provider =
    processProvider ??
    accountProvider ??
    systemProvider ??
    "workers-ai";

  const model = resolveConfig("model") ?? DEFAULT_WORKERS_AI_MODEL;
  const baseUrl = resolveConfig("base_url") ?? "";
  const providerStyle = resolveConfig("provider_style") ?? "auto";
  const transportTarget = resolveConfig("transport_target") ?? "gsv";
  const apiKey = resolveConfig("api_key") ?? "";
  const oauthAccountConfigUids = shouldResolveRootOpenAiCodexOAuth({
    provider,
    providerFromGlobalConfig: processProvider === null && accountProvider === null && systemProvider !== null,
  })
    ? withRootAiProfileScope(accountConfigUids)
    : accountConfigUids;
  const resolvedOAuth = await resolveAiProviderOAuthApiKey(
    ctx,
    oauthAccountConfigUids,
    provider,
    apiKey,
  );
  const resolvedApiKey = resolvedOAuth.apiKey;

  const reasoning = resolveConfig("reasoning") ?? undefined;

  const maxTokens = parseInt(
    resolveConfig("max_tokens") ?? "8192",
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
    resolveConfig("max_context_bytes") ?? "32768",
    10,
  );
  const generationTimeoutMs = resolveConfig("generation/timeout_ms", parsePositiveInt)
    ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationStreaming = normalizeGenerationStreaming(
    resolveConfig("generation/streaming"),
  );
  const fallbackSelection = resolveAiFallbackSelection(
    ctx,
    accountConfigUids,
    accountProfileOverrides,
    processOverrides,
  );
  const primary: AiModelStackConfig = {
    provider,
    model,
    apiKey: resolvedApiKey,
    providerStyle: providerStyle.trim().toLowerCase() || "auto",
    transportTarget: normalizeTarget(transportTarget),
    reasoning,
    maxTokens,
    contextWindowTokens,
    contextWindowSource,
    generationTimeoutMs,
    generationStreaming,
  };
  const normalizedBaseUrl = baseUrl.trim();
  if (normalizedBaseUrl) primary.baseUrl = normalizedBaseUrl;
  if (resolvedOAuth.openAiCodexAccountId) {
    primary.openAiCodex = { accountId: resolvedOAuth.openAiCodexAccountId };
  }
  const fallbacks = await resolveAiFallbackConfigs({
    ctx,
    accountUids: fallbackSelection?.accountUids ?? [],
    selector: fallbackSelection?.selector ?? "",
    primary,
  });
  const media = resolveAiMediaConfig(
    config,
    accountConfigUids,
    accountProfileOverrides,
    apiKey,
    processOverrides,
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
    provider,
    model,
    apiKey: resolvedApiKey,
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
    skillIndexMode,
    accountApprovalPolicy,
    capabilities: [...(ctx.identity?.capabilities ?? [])],
    maxContextBytes,
    generationTimeoutMs,
    generationStreaming,
    media,
  };
  if (normalizedBaseUrl) result.baseUrl = normalizedBaseUrl;
  if (resolvedOAuth.openAiCodexAccountId) {
    result.openAiCodex = { accountId: resolvedOAuth.openAiCodexAccountId };
  }
  if (fallbacks.length > 0) result.fallbacks = fallbacks;
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
  };
  if (ctx.processId) attribution.actor.processId = ctx.processId;
  if (ctx.processRunId) attribution.actor.runId = ctx.processRunId;
  return attribution;
}

function normalizeAiProcessOverrideValues(
  raw: AiConfigValues,
  options: { preserveEmpty?: boolean } = {},
): AiConfigValues {
  const values: AiConfigValues = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isProcessAiConfigKey(key)) {
      continue;
    }
    const normalized = value.trim();
    if (!normalized && !options.preserveEmpty && !PROCESS_AI_CONFIG_SECRET_KEYS.has(key)) {
      continue;
    }
    values[key] = normalized;
  }
  return values;
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
  const { primary, fallback } = await resolveAiTranscriptionStacksForContext(configContext);
  const audio = input.audio;
  if (!audio.mimeType.trim().toLowerCase().startsWith("audio/")) {
    throw new Error("audio.mimeType must be an audio MIME type");
  }

  const bytes = await readAiInputBody(body, primary.transcriptionMaxBytes, "audio", ctx.requestSignal);
  const base64 = encodeBase64Bytes(bytes);

  const mode = input.mode === "translate" ? "translate" : "transcribe";
  let lastError: unknown;
  for (const stack of [primary, ...(fallback ? [fallback] : [])]) {
    if (ctx.requestSignal?.aborted) {
      throw ctx.requestSignal.reason ?? new Error("Transcription cancelled");
    }
    try {
      const result = await transcribeAudio({
        workersAi: ctx.env.AI,
      }, {
        data: base64,
        provider: stack.transcriptionProvider,
        apiKey: stack.transcriptionApiKey,
        model: stack.transcriptionModel,
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
    } catch (error) {
      if (ctx.requestSignal?.aborted) {
        throw ctx.requestSignal.reason ?? error;
      }
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("Transcription unavailable");
}

export async function handleAiImageRead(
  args: AiImageReadArgs,
  ctx: KernelContext,
  body?: FrameBody,
): Promise<AiFrameResult<AiImageReadResult>> {
  const input = args;
  const media = await resolveAiMediaConfigForContext(ctx);
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
  const media = await resolveAiMediaConfigForContext(ctx);
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
  const overrides = {
    ...normalizeAiProcessOverrideValues(input?.processOverrides ?? {}),
    ...normalizeAiProcessOverrideValues(input?.overrides ?? {}, { preserveEmpty: true }),
  };
  const processProfile = input?.processProfile;
  const preset = input?.preset;
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

function withRootAiProfileScope(accountUids: number[]): number[] {
  return accountUids.includes(0) ? accountUids : [0, ...accountUids];
}

function shouldResolveRootOpenAiCodexOAuth({
  provider,
  providerFromGlobalConfig,
}: {
  provider: string;
  providerFromGlobalConfig: boolean;
}): boolean {
  return providerFromGlobalConfig &&
    provider.trim().toLowerCase() === "openai-codex";
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

function createAiConfigValueResolver(
  config: KernelContext["config"],
  accountUids: number[],
  accountProfileOverrides: AiAccountProfileOverrides,
  processOverrides: AiConfigValues,
  explicitSystem = false,
) {
  function resolve(key: string): string | null;
  function resolve<T>(key: string, normalize: (value: string | null) => T | null): T | null;
  function resolve<T>(
    key: string,
    normalize?: (value: string | null) => T | null,
  ): string | T | null {
    const candidates = [
      resolveAiProcessConfigValue(processOverrides, key),
      resolveAiConfigValue(config, accountUids, accountProfileOverrides, key),
      explicitSystem
        ? config.getExplicit(`config/ai/${key}`)
        : config.get(`config/ai/${key}`),
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

function resolveAiFallbackSelection(
  ctx: KernelContext,
  accountUids: number[],
  accountProfileOverrides: AiAccountProfileOverrides,
  processOverrides: Record<string, string>,
): { accountUids: number[]; selector: string } | null {
  const processSelector = resolveAiProcessConfigValue(processOverrides, "fallback_model_profile");
  const accountSelector = resolveAiConfigValue(
    ctx.config,
    accountUids,
    accountProfileOverrides,
    "fallback_model_profile",
  );
  const systemSelector = ctx.config.get("config/ai/fallback_model_profile");
  const selector = normalizeOptionalString(processSelector ?? accountSelector ?? systemSelector);
  if (!selector) {
    return null;
  }
  return {
    selector,
    accountUids: processSelector === null && accountSelector === null && systemSelector !== null
      ? withRootAiProfileScope(accountUids)
      : accountUids,
  };
}

async function resolveAiFallbackConfigs(options: {
  ctx: KernelContext;
  accountUids: number[];
  selector: string;
  primary: AiModelStackConfig;
}): Promise<AiConfigFallback[]> {
  const selector = normalizeOptionalString(options.selector);
  if (!selector || options.accountUids.length === 0) {
    return [];
  }
  const profile = findAiAccountModelProfile(
    options.ctx.config,
    options.accountUids,
    options.accountUids[0],
    selector,
  );
  if (!profile) {
    return [];
  }
  const fallback = await resolveAiFallbackModelStack(
    options.ctx,
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
  ctx: KernelContext,
  accountUids: number[],
  profileOverrides: Record<string, string>,
): Promise<AiModelStackConfig> {
  const config = ctx.config;
  const emptyProfileOverrides: AiAccountProfileOverrides = new Map();
  const resolveConfig = createAiConfigValueResolver(
    config,
    accountUids,
    emptyProfileOverrides,
    profileOverrides,
  );
  const provider = resolveConfig("provider") ?? "workers-ai";
  const model = resolveConfig("model") ?? DEFAULT_WORKERS_AI_MODEL;
  const baseUrl = resolveConfig("base_url") ?? "";
  const providerStyle = resolveConfig("provider_style") ?? "auto";
  const transportTarget = resolveConfig("transport_target") ?? "gsv";
  const apiKey = resolveConfig("api_key") ?? "";
  const resolvedOAuth = await resolveAiProviderOAuthApiKey(ctx, accountUids, provider, apiKey);
  const resolvedApiKey = resolvedOAuth.apiKey;
  const reasoning = resolveConfig("reasoning") ?? undefined;
  const maxTokens = parseInt(
    resolveConfig("max_tokens") ?? "8192",
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
  const generationTimeoutMs = resolveConfig("generation/timeout_ms", parsePositiveInt)
    ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationStreaming = normalizeGenerationStreaming(
    resolveConfig("generation/streaming"),
  );

  const result: AiModelStackConfig = {
    provider,
    model,
    apiKey: resolvedApiKey,
    providerStyle: providerStyle.trim().toLowerCase() || "auto",
    transportTarget: normalizeTarget(transportTarget),
    reasoning,
    maxTokens,
    contextWindowTokens,
    contextWindowSource,
    generationTimeoutMs,
    generationStreaming,
  };
  const normalizedBaseUrl = baseUrl.trim();
  if (normalizedBaseUrl) result.baseUrl = normalizedBaseUrl;
  if (resolvedOAuth.openAiCodexAccountId) {
    result.openAiCodex = { accountId: resolvedOAuth.openAiCodexAccountId };
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

async function resolveAiTranscriptionStacksForContext(ctx: KernelContext): Promise<{
  primary: NonNullable<AiConfigResult["media"]>;
  fallback?: AiTranscriptionStack;
}> {
  const resolution = await resolveAiMediaContext(ctx);
  const primary = resolveAiMediaConfig(
    ctx.config,
    resolution.accountUids,
    resolution.accountProfileOverrides,
    resolution.defaultApiKey,
    resolution.processOverrides,
  );
  const fallbackSelection = resolveAiFallbackSelection(
    ctx,
    resolution.accountUids,
    resolution.accountProfileOverrides,
    resolution.processOverrides,
  );
  if (!fallbackSelection) {
    return { primary };
  }
  const profile = findAiAccountModelProfile(
    ctx.config,
    fallbackSelection.accountUids,
    fallbackSelection.accountUids[0],
    fallbackSelection.selector,
  );
  if (!profile) {
    return { primary };
  }
  const fallbackProvider = normalizeProviderName(
    resolveAiProcessConfigValue(profile.values, "transcription/provider"),
  );
  const fallbackModel = normalizeOptionalString(
    resolveAiProcessConfigValue(profile.values, "transcription/model"),
  );
  if (!fallbackProvider || !fallbackModel) {
    return { primary };
  }
  const fallbackMedia = resolveAiMediaConfig(
    ctx.config,
    fallbackSelection.accountUids,
    new Map(),
    resolveAiProcessConfigValue(profile.values, "api_key") ?? resolution.defaultApiKey,
    profile.values,
  );
  const fallback: AiTranscriptionStack = {
    transcriptionProvider: fallbackProvider,
    transcriptionModel: fallbackModel,
    transcriptionApiKey: fallbackMedia.transcriptionApiKey,
  };
  return isSameAiTranscriptionStack(primary, fallback)
    ? { primary }
    : { primary, fallback };
}

function isSameAiTranscriptionStack(
  left: AiTranscriptionStack,
  right: AiTranscriptionStack,
): boolean {
  return left.transcriptionProvider.trim().toLowerCase() ===
      right.transcriptionProvider.trim().toLowerCase() &&
    left.transcriptionModel.trim().toLowerCase() ===
      right.transcriptionModel.trim().toLowerCase() &&
    left.transcriptionApiKey === right.transcriptionApiKey;
}

async function resolveAiMediaConfigForContext(ctx: KernelContext): Promise<NonNullable<AiConfigResult["media"]>> {
  const resolution = await resolveAiMediaContext(ctx);
  return resolveAiMediaConfig(
    ctx.config,
    resolution.accountUids,
    resolution.accountProfileOverrides,
    resolution.defaultApiKey,
    resolution.processOverrides,
  );
}

async function resolveAiMediaContext(ctx: KernelContext): Promise<{
  accountUids: number[];
  accountProfileOverrides: AiAccountProfileOverrides;
  processOverrides: Record<string, string>;
  defaultApiKey: string;
}> {
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
  return {
    accountUids: accountConfigUids,
    accountProfileOverrides,
    processOverrides,
    defaultApiKey: apiKey,
  };
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
    frame = await raceWithAbort(
      sendFrameToProcess(ctx.installationId, ctx.processId, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.ai.config.get",
        args: { redacted: false },
      }),
      ctx.requestSignal,
    );
  } catch (error) {
    if (ctx.requestSignal?.aborted) {
      throw ctx.requestSignal.reason ?? error;
    }
    return {};
  }
  if (!frame || frame.type !== "res" || !frame.ok) {
    return {};
  }

  // SAFETY: proc.ai.config.get returns the typed result for this exact internal request.
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
  processOverrides: AiConfigValues | undefined,
  processProfile: ProcAiConfigProfileRef | null | undefined,
): AiConfigValues {
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
): AiConfigValues {
  const profileId = normalizeOptionalString(profile?.id);
  if (!profileId) {
    return {};
  }
  const values: AiConfigValues = {};
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
  const resolveConfig = createAiConfigValueResolver(
    config,
    accountUids,
    accountProfileOverrides,
    processOverrides,
  );
  const resolveExplicitConfig = createAiConfigValueResolver(
    config,
    accountUids,
    accountProfileOverrides,
    processOverrides,
    true,
  );
  const transcriptionProvider = resolveExplicitConfig("transcription/provider", normalizeProviderName)
    ?? "workers-ai";
  const transcriptionModel = resolveExplicitConfig("transcription/model")
    ?? defaultTranscriptionModelForProvider(transcriptionProvider);
  const transcriptionApiKey = resolveExplicitConfig("transcription/api_key", normalizeOptionalString)
    ?? defaultApiKey;
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
  const imageGenerationProvider = resolveExplicitConfig("image/generation/provider", normalizeProviderName)
    ?? "workers-ai";
  const imageGenerationModel = resolveExplicitConfig("image/generation/model")
    ?? defaultImageGenerationModelForProvider(imageGenerationProvider);
  const imageGenerationApiKey = resolveExplicitConfig("image/generation/api_key", normalizeOptionalString)
    ?? defaultApiKey;
  const speechProvider = resolveExplicitConfig("speech/provider", normalizeProviderName)
    ?? "workers-ai";
  const speechModel = resolveExplicitConfig("speech/model")
    ?? defaultSpeechModelForProvider(speechProvider);
  const speechApiKey = resolveExplicitConfig("speech/api_key", normalizeOptionalString)
    ?? defaultApiKey;
  const speechSpeaker = resolveExplicitConfig("speech/speaker")
    ?? defaultSpeechSpeakerForProvider(speechProvider);
  const speechEncoding = resolveConfig("speech/encoding") ?? DEFAULT_AUDIO_SPEECH_ENCODING;
  const speechMaxChars = resolveConfig("speech/max_chars", parsePositiveInt)
    ?? DEFAULT_MAX_AUDIO_SPEECH_CHARS;
  const speechTimeoutMs = resolveConfig("speech/timeout_ms", parsePositiveInt)
    ?? DEFAULT_AUDIO_SPEECH_TIMEOUT_MS;

  return {
    transcriptionProvider,
    transcriptionModel,
    transcriptionApiKey,
    transcriptionMaxBytes,
    imageReadingMaxBytes,
    imageReadingMaxTokens,
    imageReadingMaxObjects,
    imageReadingTimeoutMs,
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

function normalizeProviderName(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized ?? null;
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
