import { defineCommand, type Command, type CommandContext, type ExecResult } from "just-bash";
import type { GsvFs } from "../../../fs/gsv-fs";
import {
  handleAiImageGenerate,
  handleAiImageRead,
  handleAiSpeechCreate,
  handleAiTranscriptionCreate,
} from "../../../kernel/ai";
import type { KernelContext } from "../../../kernel/context";
import { requireCommandCapability, requireShellOptionValue } from "./common";

type ParsedArgs = {
  options: Map<string, string | true>;
  positionals: string[];
};

type ParseSpec = {
  boolean: readonly string[];
  value: readonly string[];
  aliases?: Record<string, string>;
};

export function buildMediaCommands(fs: GsvFs, ctx: KernelContext): Command[] {
  return [
    defineMediaCommand("img2txt", (args, shellCtx) => runImg2Txt(args, shellCtx, fs, ctx)),
    defineMediaCommand("txt2img", (args, shellCtx) => runTxt2Img(args, shellCtx, fs, ctx)),
    defineMediaCommand("stt", (args, shellCtx) => runStt(args, shellCtx, fs, ctx)),
    defineMediaCommand("tts", (args, shellCtx) => runTts(args, shellCtx, fs, ctx)),
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
  fs: GsvFs,
  ctx: KernelContext,
): Promise<ExecResult> {
  const parsed = parseArgs(args, {
    boolean: ["help", "json"],
    value: ["mime", "prompt", "model", "input-format", "max-tokens"],
    aliases: { h: "help" },
  });
  if (hasOption(parsed, "help")) {
    return ok(img2txtUsage());
  }
  requireCommandCapability(ctx, "ai.image.read");
  if (parsed.positionals.length !== 1) {
    throw new Error("expected exactly one image path");
  }

  const path = resolvePath(shellCtx, parsed.positionals[0]);
  const maxTokens = parsePositiveIntOption(optionValue(parsed, "max-tokens"), "--max-tokens");
  const requestCtx = withShellSignal(ctx, shellCtx);
  const opened = await fs.openFile(path);
  const stream = opened.body;
  if (!stream) {
    throw new Error(`cannot read image data for ${path}`);
  }
  const result = await usingStream(stream, async () => {
    const mimeType = optionValue(parsed, "mime")
      ?? storedMediaMimeType(opened.contentType, "image")
      ?? inferImageMimeType(path);
    if (!mimeType) {
      throw new Error(`cannot infer image MIME type for ${path}; pass --mime image/...`);
    }
    return handleAiImageRead({
      image: {
        mimeType,
        filename: pathName(path),
      },
      prompt: optionValue(parsed, "prompt"),
      model: optionValue(parsed, "model"),
      inputFormat: normalizeInputFormatOption(optionValue(parsed, "input-format")),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    }, requestCtx, { stream, length: opened.size });
  });

  if (hasOption(parsed, "json")) {
    return okJson(result);
  }
  return ok(`${result.text}\n`);
}

async function runTxt2Img(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
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
  const response = await handleAiImageGenerate({
    prompt,
    model: optionValue(parsed, "model"),
    size: optionValue(parsed, "size"),
    quality: optionValue(parsed, "quality"),
    format: optionValue(parsed, "format"),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }, requestCtx);
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
    return okJson({
      output: outputPath,
      mimeType: result.image.mimeType,
      size: result.image.size,
      provider: result.provider,
      model: result.model,
      ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
    });
  }
  return ok(`${outputPath}\n`);
}

async function runStt(
  args: string[],
  shellCtx: CommandContext,
  fs: GsvFs,
  ctx: KernelContext,
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
    return handleAiTranscriptionCreate({
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
  fs: GsvFs,
  ctx: KernelContext,
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
  const response = await handleAiSpeechCreate({
    text,
    textFormat: hasOption(parsed, "plain") ? "plain" : hasOption(parsed, "markdown") ? "markdown" : undefined,
    model: optionValue(parsed, "model"),
    voice: optionValue(parsed, "voice"),
    language: optionValue(parsed, "language"),
    encoding,
    container: optionValue(parsed, "container"),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(bitRate !== undefined ? { bitRate } : {}),
  }, requestCtx);
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
    return okJson({
      output: outputPath,
      mimeType: result.audio.mimeType,
      size: result.audio.size,
      provider: result.provider,
      model: result.model,
      ...(result.voice ? { voice: result.voice } : {}),
      ...(result.encoding ? { encoding: result.encoding } : {}),
      ...(result.container ? { container: result.container } : {}),
    });
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function normalizeInputFormatOption(value: string | undefined): "auto" | "chat" | "image" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "auto" || value === "chat" || value === "image") {
    return value;
  }
  throw new Error("--input-format must be auto, chat, or image");
}

function readTextArgument(positionals: string[], ctx: CommandContext, label: string): string {
  const text = positionals.join(" ").trim() || ctx.stdin.trim();
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

function okJson(value: unknown): ExecResult {
  return ok(`${JSON.stringify(value, null, 2)}\n`);
}

function img2txtUsage(): string {
  return [
    "img2txt [OPTIONS] IMAGE",
    "",
    "Describe an image with the configured image-reading model.",
    "",
    "Options:",
    "  --prompt TEXT",
    "  --model MODEL",
    "  --input-format auto|chat|image",
    "  --max-tokens N",
    "  --mime MIME",
    "  --json",
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
