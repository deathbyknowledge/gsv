import {
  defineCommand,
  type Command,
  type CommandContext,
  type ExecResult,
} from "just-bash";
import {
  bodyToText,
  jsonObjectSchema,
  type AiImageReadArgs,
  type AiImageReadResult,
  type AiImageReadResponseFormat,
  type JsonObject,
  type AiImageGenerateArgs,
  type AiSpeechCreateArgs,
  type AiTranscriptionCreateResult,
} from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import {
  handleAiImageGenerate,
  handleAiImageRead,
  handleAiSpeechCreate,
  handleAiTranscriptionCreate,
} from "../../../kernel/ai";
import type { KernelContext } from "../../../kernel/context";
import { openFsSource, type FsDeviceTransport } from "../fs";
import { requireCommandCapability, requireShellOptionValue } from "./common";
import { parseShellFsEndpoint } from "./fs-path";
import { decodeShellStdin } from "./stdin";

export type MediaHandlers = {
  imageGenerate: typeof handleAiImageGenerate;
  imageRead: typeof handleAiImageRead;
  speechCreate: typeof handleAiSpeechCreate;
  transcriptionCreate: typeof handleAiTranscriptionCreate;
};

const DEFAULT_MEDIA_HANDLERS: MediaHandlers = {
  imageGenerate: handleAiImageGenerate,
  imageRead: handleAiImageRead,
  speechCreate: handleAiSpeechCreate,
  transcriptionCreate: handleAiTranscriptionCreate,
};

type ParsedArgs = {
  options: Map<string, string | true>;
  positionals: string[];
};

type ParseSpec = {
  boolean: readonly string[];
  value: readonly string[];
  aliases?: Record<string, string>;
};

type ImageReadCommon = {
  image: { mimeType: string; filename?: string };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
};

type Img2TxtMode = "caption" | "query" | "ocr" | "point" | "detect";
type Img2TxtModeResult = { value: Img2TxtMode; explicit: boolean };
type JsonOutput =
  | JsonObject
  | string
  | number
  | boolean
  | null
  | JsonOutput[]
  | AiImageReadResult
  | AiTranscriptionCreateResult;
type ModeOptionSet = {
  "--prompt"?: string;
  "--target"?: string;
  "--response-format"?: string;
  "--schema"?: JsonObject;
  "--reasoning"?: boolean;
  "--max-objects"?: number;
  "--stream"?: boolean;
  "--max-tokens"?: number;
  "--temperature"?: number;
  "--top-p"?: number;
};

export type MediaFs = Pick<GsvFs, "resolvePath" | "openFile" | "writeFileStream">;

export function buildMediaCommands(
  fs: MediaFs,
  ctx: KernelContext,
  fsTransport?: FsDeviceTransport,
  handlers: MediaHandlers = DEFAULT_MEDIA_HANDLERS,
): Command[] {
  return [
    defineMediaCommand("img2txt", (args, shellCtx) => (
      runImg2Txt(args, shellCtx, fs, ctx, fsTransport, handlers)
    )),
    defineMediaCommand("txt2img", (args, shellCtx) => runTxt2Img(args, shellCtx, fs, ctx, handlers)),
    defineMediaCommand("stt", (args, shellCtx) => runStt(args, shellCtx, fs, ctx, handlers)),
    defineMediaCommand("tts", (args, shellCtx) => runTts(args, shellCtx, fs, ctx, handlers)),
  ];
}

function defineMediaCommand(
  name: string,
  run: (args: string[], ctx: CommandContext) => Promise<ExecResult>,
): Command {
  return defineCommand(name, async (args, commandCtx): Promise<ExecResult> => {
    try {
      return await run(args, commandCtx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `${name}: ${message}\n`, exitCode: 1 };
    }
  });
}

async function runImg2Txt(
  args: string[],
  shellCtx: CommandContext,
  fs: MediaFs,
  ctx: KernelContext,
  fsTransport?: FsDeviceTransport,
  handlers: MediaHandlers = DEFAULT_MEDIA_HANDLERS,
): Promise<ExecResult> {
  const mode = parseImg2TxtMode(args[0]);
  const parsed = parseArgs(mode.explicit ? args.slice(1) : args, {
    boolean: ["help", "json", "stream", "reasoning"],
    value: [
      "mime",
      "prompt",
      "target",
      "length",
      "response-format",
      "schema",
      "max-tokens",
      "max-objects",
      "temperature",
      "top-p",
    ],
    aliases: { h: "help" },
  });
  if (hasOption(parsed, "help")) {
    return ok(img2txtUsage());
  }
  requireCommandCapability(ctx, "ai.image.read");
  if (parsed.positionals.length !== 1) {
    throw new Error("expected exactly one image path");
  }

  const source = parseShellFsEndpoint(parsed.positionals[0], shellCtx, ctx);
  const maxTokens = parsePositiveIntOption(optionValue(parsed, "max-tokens"), "--max-tokens");
  const maxObjects = parsePositiveIntOption(optionValue(parsed, "max-objects"), "--max-objects");
  const temperature = parseNumberOption(optionValue(parsed, "temperature"), "--temperature", 0, 2);
  const topP = parseNumberOption(optionValue(parsed, "top-p"), "--top-p", 0, 1);
  const streamOutput = hasOption(parsed, "stream");
  if (streamOutput && hasOption(parsed, "json")) {
    throw new Error("--stream cannot be combined with --json");
  }
  const requestCtx = withShellSignal(ctx, shellCtx);
  const opened = await openFsSource(source, requestCtx, {
    fs,
    transport: fsTransport,
  });
  const stream = opened.body.stream;
  const response = await usingStream(stream, async () => {
    const mimeType = optionValue(parsed, "mime")
      ?? storedMediaMimeType(opened.contentType, "image")
      ?? inferImageMimeType(source.path);
    if (!mimeType) {
      throw new Error(`cannot infer image MIME type for ${source.path}; pass --mime image/...`);
    }
    const common: ImageReadCommon = {
      image: {
        mimeType,
        filename: pathName(source.path),
      },
    };
    if (maxTokens !== undefined) common.maxTokens = maxTokens;
    if (temperature !== undefined) common.temperature = temperature;
    if (topP !== undefined) common.topP = topP;
    const request = buildImg2TxtRequest(mode.value, parsed, common, {
      maxObjects,
      stream: streamOutput,
    });
    return handlers.imageRead(request, requestCtx, opened.body);
  });

  const result = response.data;
  if (response.body) {
    const text = await bodyToText(response.body, Infinity, requestCtx.requestSignal);
    return ok(text.endsWith("\n") ? text : `${text}\n`);
  }
  if (hasOption(parsed, "json")) {
    return okJson(result);
  }
  if (result.mode === "caption" || result.mode === "query" || result.mode === "ocr") {
    if ("text" in result) {
      return ok(`${result.text}\n`);
    }
    throw new Error("streaming returned no response body");
  }
  return okJson(result);
}

async function runTxt2Img(
  args: string[],
  shellCtx: CommandContext,
  fs: MediaFs,
  ctx: KernelContext,
  handlers: MediaHandlers,
): Promise<ExecResult> {
  const parsed = parseArgs(args, {
    boolean: ["help", "json"],
    value: ["out", "model", "size", "quality", "format", "timeout-ms"],
    aliases: { h: "help", o: "out", output: "out" },
  });
  if (hasOption(parsed, "help")) {
    return ok(txt2imgUsage());
  }
  requireCommandCapability(ctx, "ai.image.generate");
  const out = requireOption(parsed, "out", "-o/--out");
  const prompt = readTextArgument(parsed.positionals, shellCtx, "prompt");
  const timeoutMs = parsePositiveIntOption(optionValue(parsed, "timeout-ms"), "--timeout-ms");

  const requestCtx = withShellSignal(ctx, shellCtx);
  const request: AiImageGenerateArgs = {
    prompt,
    model: optionValue(parsed, "model"),
    size: optionValue(parsed, "size"),
    quality: optionValue(parsed, "quality"),
    format: optionValue(parsed, "format"),
  };
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
  const response = await handlers.imageGenerate(request, requestCtx);
  const result = response.data;
  const body = response.body;
  if (!body || result.image.size <= 0) {
    await body?.stream.cancel().catch(() => {});
    throw new Error(result.url
      ? `image generation returned a URL instead of inline image data: ${result.url}`
      : "image generation returned no image data");
  }
  const outputPath = await usingStream(body.stream, async () => {
    const path = resolvePath(shellCtx, out);
    await fs.writeFileStream(path, body.stream, {
      expectedSize: result.image.size,
      contentType: result.image.mimeType,
      signal: requestCtx.requestSignal,
    });
    return path;
  });

  if (hasOption(parsed, "json")) {
    const output: JsonObject = {
      output: outputPath,
      mimeType: result.image.mimeType,
      size: result.image.size,
      provider: result.provider,
      model: result.model,
    };
    if (result.revisedPrompt) output.revisedPrompt = result.revisedPrompt;
    return okJson(output);
  }
  return ok(`${outputPath}\n`);
}

async function runStt(
  args: string[],
  shellCtx: CommandContext,
  fs: MediaFs,
  ctx: KernelContext,
  handlers: MediaHandlers,
): Promise<ExecResult> {
  const parsed = parseArgs(args, {
    boolean: ["help", "json", "translate"],
    value: ["mime", "language", "prompt"],
    aliases: { h: "help" },
  });
  if (hasOption(parsed, "help")) {
    return ok(sttUsage());
  }
  requireCommandCapability(ctx, "ai.transcription.create");
  if (parsed.positionals.length !== 1) {
    throw new Error("expected exactly one audio path");
  }

  const path = resolvePath(shellCtx, parsed.positionals[0]);
  const requestCtx = withShellSignal(ctx, shellCtx);
  const opened = await fs.openFile(path);
  const stream = opened.body;
  if (!stream) {
    throw new Error(`cannot read audio data for ${path}`);
  }
  const result = await usingStream(stream, async () => {
    const mimeType = optionValue(parsed, "mime")
      ?? storedMediaMimeType(opened.contentType, "audio")
      ?? inferAudioMimeType(path);
    if (!mimeType) {
      throw new Error(`cannot infer audio MIME type for ${path}; pass --mime audio/...`);
    }
    return handlers.transcriptionCreate({
      audio: {
        mimeType,
        filename: pathName(path),
      },
      language: optionValue(parsed, "language"),
      prompt: optionValue(parsed, "prompt"),
      mode: hasOption(parsed, "translate") ? "translate" : "transcribe",
    }, requestCtx, { stream, length: opened.size });
  });

  if (hasOption(parsed, "json")) {
    return okJson(result);
  }
  return ok(`${result.text}\n`);
}

async function runTts(
  args: string[],
  shellCtx: CommandContext,
  fs: MediaFs,
  ctx: KernelContext,
  handlers: MediaHandlers,
): Promise<ExecResult> {
  const parsed = parseArgs(args, {
    boolean: ["help", "json", "plain", "markdown"],
    value: ["out", "model", "voice", "language", "encoding", "format", "container", "sample-rate", "bit-rate"],
    aliases: { h: "help", o: "out", output: "out" },
  });
  if (hasOption(parsed, "help")) {
    return ok(ttsUsage());
  }
  requireCommandCapability(ctx, "ai.speech.create");
  const out = requireOption(parsed, "out", "-o/--out");
  const text = readTextArgument(parsed.positionals, shellCtx, "text");
  const sampleRate = parsePositiveIntOption(optionValue(parsed, "sample-rate"), "--sample-rate");
  const bitRate = parsePositiveIntOption(optionValue(parsed, "bit-rate"), "--bit-rate");
  const encoding = optionValue(parsed, "encoding") ?? optionValue(parsed, "format");

  const requestCtx = withShellSignal(ctx, shellCtx);
  const request: AiSpeechCreateArgs = {
    text,
    textFormat: hasOption(parsed, "plain") ? "plain" : hasOption(parsed, "markdown") ? "markdown" : undefined,
    model: optionValue(parsed, "model"),
    voice: optionValue(parsed, "voice"),
    language: optionValue(parsed, "language"),
    encoding,
    container: optionValue(parsed, "container"),
  };
  if (sampleRate !== undefined) request.sampleRate = sampleRate;
  if (bitRate !== undefined) request.bitRate = bitRate;
  const response = await handlers.speechCreate(request, requestCtx);
  const result = response.data;
  if (result.skipped) {
    return hasOption(parsed, "json")
      ? okJson({ output: null, skipped: true, provider: result.provider, model: result.model })
      : ok("skipped\n");
  }
  const body = response.body;
  if (!body || result.audio.size <= 0) {
    await body?.stream.cancel().catch(() => {});
    throw new Error("speech synthesis returned no audio data");
  }
  const outputPath = await usingStream(body.stream, async () => {
    const path = resolvePath(shellCtx, out);
    await fs.writeFileStream(path, body.stream, {
      expectedSize: result.audio.size,
      contentType: result.audio.mimeType,
      signal: requestCtx.requestSignal,
    });
    return path;
  });

  if (hasOption(parsed, "json")) {
    const output: JsonObject = {
      output: outputPath,
      mimeType: result.audio.mimeType,
      size: result.audio.size,
      provider: result.provider,
      model: result.model,
    };
    if (result.voice) output.voice = result.voice;
    if (result.encoding) output.encoding = result.encoding;
    if (result.container) output.container = result.container;
    return okJson(output);
  }
  return ok(`${outputPath}\n`);
}

function parseArgs(args: string[], spec: ParseSpec): ParsedArgs {
  const booleanOptions = new Set(spec.boolean);
  const valueOptions = new Set(spec.value);
  const aliases = spec.aliases ?? {};
  const options = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const equalsIndex = arg.indexOf("=");
      const rawName = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
      const name = aliases[rawName] ?? rawName;
      if (booleanOptions.has(name)) {
        if (equalsIndex >= 0) {
          throw new Error(`--${rawName} does not take a value`);
        }
        options.set(name, true);
        continue;
      }
      if (valueOptions.has(name)) {
        const value = equalsIndex >= 0
          ? arg.slice(equalsIndex + 1)
          : requireShellOptionValue(args[++index], `--${rawName}`);
        options.set(name, value);
        continue;
      }
      throw new Error(`unsupported option: --${rawName}`);
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const rawName = arg.slice(1);
      const name = aliases[rawName] ?? rawName;
      if (booleanOptions.has(name)) {
        options.set(name, true);
        continue;
      }
      if (valueOptions.has(name)) {
        options.set(name, requireShellOptionValue(args[++index], `-${rawName}`));
        continue;
      }
      throw new Error(`unsupported option: -${rawName}`);
    }
    positionals.push(arg);
  }

  return { options, positionals };
}

function hasOption(parsed: ParsedArgs, name: string): boolean {
  return parsed.options.get(name) === true;
}

function optionValue(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  if (value === undefined || value === true) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireOption(parsed: ParsedArgs, name: string, label: string): string {
  const value = optionValue(parsed, name);
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parsePositiveIntOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNumberOption(
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseImg2TxtMode(value: string | undefined): Img2TxtModeResult {
  if (
    value === "caption"
    || value === "query"
    || value === "ocr"
    || value === "point"
    || value === "detect"
  ) {
    return { value, explicit: true };
  }
  return { value: "caption", explicit: false };
}

function buildImg2TxtRequest(
  mode: Img2TxtMode,
  parsed: ParsedArgs,
  common: ImageReadCommon,
  options: {
    maxObjects?: number;
    stream: boolean;
  },
): AiImageReadArgs {
  const prompt = optionValue(parsed, "prompt");
  const target = optionValue(parsed, "target");
  const responseFormat = normalizeResponseFormatOption(optionValue(parsed, "response-format"));
  const schema = parseSchemaOption(optionValue(parsed, "schema"));
  const captionLength = normalizeCaptionLengthOption(optionValue(parsed, "length"));
  const reasoning = hasOption(parsed, "reasoning");

  if (mode === "caption") {
    rejectModeOptions(mode, {
      "--prompt": prompt,
      "--target": target,
      "--response-format": responseFormat,
      "--schema": schema,
      "--reasoning": reasoning,
      "--max-objects": options.maxObjects,
    });
    const request = {
      ...common,
      mode,
    };
    if (captionLength) Object.assign(request, { captionLength });
    if (options.stream) Object.assign(request, { stream: true });
    return request;
  }
  if (captionLength) {
    throw new Error("--length is supported only for caption mode");
  }
  if (mode === "query") {
    if (!prompt) {
      throw new Error("--prompt is required for query mode");
    }
    rejectModeOptions(mode, {
      "--target": target,
      "--max-objects": options.maxObjects,
    });
    const request = {
      ...common,
      mode,
      prompt,
    };
    if (reasoning) Object.assign(request, { reasoning: true });
    if (responseFormat) Object.assign(request, { responseFormat });
    if (schema) Object.assign(request, { schema });
    if (options.stream) Object.assign(request, { stream: true });
    return request;
  }
  if (mode === "ocr") {
    rejectModeOptions(mode, {
      "--target": target,
      "--reasoning": reasoning,
      "--max-objects": options.maxObjects,
    });
    const request = {
      ...common,
      mode,
    };
    if (prompt) Object.assign(request, { prompt });
    if (responseFormat) Object.assign(request, { responseFormat });
    if (schema) Object.assign(request, { schema });
    if (options.stream) Object.assign(request, { stream: true });
    return request;
  }

  if (!target) {
    throw new Error(`--target is required for ${mode} mode`);
  }
  rejectModeOptions(mode, {
    "--prompt": prompt,
    "--response-format": responseFormat,
    "--schema": schema,
    "--reasoning": reasoning,
    "--stream": options.stream,
    "--max-tokens": common.maxTokens,
    "--temperature": common.temperature,
    "--top-p": common.topP,
  });
  const request = {
    image: common.image,
    mode,
    target,
  };
  if (options.maxObjects !== undefined) Object.assign(request, { maxObjects: options.maxObjects });
  return request;
}

function rejectModeOptions(
  mode: string,
  options: ModeOptionSet,
): void {
  const unsupported = Object.entries(options)
    .find(([, value]) => value !== undefined && value !== false);
  if (unsupported) {
    throw new Error(`${unsupported[0]} is not supported for ${mode} mode`);
  }
}

function normalizeCaptionLengthOption(
  value: string | undefined,
): "short" | "normal" | "long" | undefined {
  if (value === undefined || value === "short" || value === "normal" || value === "long") {
    return value;
  }
  throw new Error("--length must be short, normal, or long");
}

function normalizeResponseFormatOption(
  value: string | undefined,
): AiImageReadResponseFormat | undefined {
  if (
    value === undefined
    || value === "text"
    || value === "json"
    || value === "xml"
    || value === "markdown"
    || value === "csv"
  ) {
    return value;
  }
  throw new Error("--response-format must be text, json, xml, markdown, or csv");
}

function parseSchemaOption(value: string | undefined): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  let parsed: JsonObject;
  try {
    const validated = jsonObjectSchema.safeParse(JSON.parse(value));
    if (!validated.success) {
      throw new Error("invalid schema");
    }
    parsed = validated.data;
  } catch {
    throw new Error("--schema must be a JSON object");
  }
  return parsed;
}

function readTextArgument(positionals: string[], ctx: CommandContext, label: string): string {
  const text = positionals.join(" ").trim() || decodeShellStdin(ctx.stdin).trim();
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function resolvePath(ctx: CommandContext, path: string): string {
  return ctx.fs.resolvePath(ctx.cwd, path);
}

function inferImageMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return undefined;
}

function inferAudioMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".opus")) return "audio/opus";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".flac")) return "audio/flac";
  return undefined;
}

function storedMediaMimeType(value: string | undefined, type: "image" | "audio"): string | undefined {
  const normalized = value?.trim();
  return normalized?.toLowerCase().startsWith(`${type}/`) ? normalized : undefined;
}

function withShellSignal(ctx: KernelContext, shellCtx: CommandContext): KernelContext {
  return shellCtx.signal && shellCtx.signal !== ctx.requestSignal
    ? { ...ctx, requestSignal: shellCtx.signal }
    : ctx;
}

async function usingStream<T>(stream: ReadableStream<Uint8Array>, use: () => Promise<T>): Promise<T> {
  try {
    return await use();
  } finally {
    if (!stream.locked) {
      await stream.cancel().catch(() => {});
    }
  }
}

function pathName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function okJson(value: JsonOutput): ExecResult {
  return ok(`${JSON.stringify(value, null, 2)}\n`);
}

function img2txtUsage(): string {
  return [
    "img2txt [caption] [OPTIONS] IMAGE",
    "img2txt query --prompt TEXT [OPTIONS] IMAGE",
    "img2txt ocr [OPTIONS] IMAGE",
    "img2txt point --target TEXT [OPTIONS] IMAGE",
    "img2txt detect --target TEXT [OPTIONS] IMAGE",
    "",
    "Read an image with Moondream. Caption mode is the default.",
    "IMAGE may be local, gsv:/path, target:/path, or [target-with-colons]:/path.",
    "",
    "Options:",
    "  --prompt TEXT                  Query or OCR instructions",
    "  --target TEXT                  Object phrase for point or detect",
    "  --length short|normal|long     Caption length",
    "  --reasoning                    Include query reasoning and grounding",
    "  --response-format FORMAT       text|json|xml|markdown|csv",
    "  --schema JSON                  JSON Schema for structured JSON output",
    "  --stream                       Stream caption/query/OCR model output",
    "  --max-tokens N                 Caption/query/OCR token limit",
    "  --max-objects N                Point/detect result limit",
    "  --temperature N                Caption/query/OCR sampling, 0..2",
    "  --top-p N                      Caption/query/OCR sampling, 0..1",
    "  --mime MIME",
    "  --json                         Print the complete result envelope",
    "",
  ].join("\n");
}

function txt2imgUsage(): string {
  return [
    "txt2img [OPTIONS] PROMPT...",
    "",
    "Generate an image with the configured image-generation model.",
    "",
    "Options:",
    "  -o, --out PATH",
    "  --model MODEL",
    "  --size SIZE",
    "  --quality QUALITY",
    "  --format png|jpeg|webp",
    "  --timeout-ms N",
    "  --json",
    "",
  ].join("\n");
}

function sttUsage(): string {
  return [
    "stt [OPTIONS] AUDIO",
    "",
    "Transcribe audio with the configured speech-to-text model.",
    "",
    "Options:",
    "  --language LANGUAGE",
    "  --prompt TEXT",
    "  --translate",
    "  --mime MIME",
    "  --json",
    "",
  ].join("\n");
}

function ttsUsage(): string {
  return [
    "tts [OPTIONS] TEXT...",
    "",
    "Synthesize speech with the configured text-to-speech model.",
    "",
    "Options:",
    "  -o, --out PATH",
    "  --voice VOICE",
    "  --model MODEL",
    "  --language LANGUAGE",
    "  --encoding ENCODING",
    "  --format ENCODING",
    "  --container CONTAINER",
    "  --plain",
    "  --markdown",
    "  --json",
    "",
  ].join("\n");
}
