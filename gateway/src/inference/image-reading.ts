import type {
  AssistantMessage,
  Context,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { decodeBase64Bytes, normalizeBase64Data } from "../shared/base64";
import { resolvePiAiModel } from "./model-registry";
import { completePiAiSimple } from "./pi-ai";
import { withTimeout } from "./timeout";
import { isWorkersAiProvider } from "./workers-ai";

export type ImageReadingBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

export type ImageReadingRequest = {
  data: string;
  mimeType?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  prompt?: string;
  inputFormat?: ImageReadingInputFormat | string;
  maxTokens?: number;
  timeoutMs?: number;
};

export type ImageReadingInputFormat = "auto" | "chat" | "image";

export type ImageReadingResult = {
  text: string;
  provider: string;
  model: string;
};

export const DEFAULT_IMAGE_READING_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const DEFAULT_IMAGE_READING_PROMPT =
  "Describe this image for an AI assistant that cannot see it. Include visible text, UI details, objects, people, layout, and any information needed to answer follow-up questions.";
export const DEFAULT_IMAGE_READING_INPUT_FORMAT: ImageReadingInputFormat = "auto";
export const DEFAULT_MAX_IMAGE_READING_BYTES = 10 * 1024 * 1024;
export const DEFAULT_IMAGE_READING_MAX_TOKENS = 512;
export const DEFAULT_IMAGE_READING_TIMEOUT_MS = 30_000;

export async function readImageWithWorkersAi(
  ai: ImageReadingBinding | undefined,
  request: ImageReadingRequest,
): Promise<ImageReadingResult | null> {
  if (!ai) {
    return null;
  }

  const model = normalizeOptionalText(request.model) || DEFAULT_IMAGE_READING_MODEL;
  const base64 = normalizeBase64Data(request.data);
  const bytes = Array.from(decodeBase64Bytes(base64));
  if (bytes.length === 0) {
    return null;
  }

  const prompt = normalizeOptionalText(request.prompt) || DEFAULT_IMAGE_READING_PROMPT;
  const maxTokens = normalizePositiveNumber(request.maxTokens) ?? DEFAULT_IMAGE_READING_MAX_TOKENS;
  const inputFormat = resolveImageReadingInputFormat(request.inputFormat, model);
  const timeoutMs = normalizePositiveNumber(request.timeoutMs) ?? DEFAULT_IMAGE_READING_TIMEOUT_MS;
  const response = await withTimeout(
    ai.run(model, inputFormat === "image"
      ? buildImagePromptInput(bytes, prompt, maxTokens)
      : buildChatVisionInput(base64, request.mimeType, prompt, maxTokens)),
    timeoutMs,
    `Image reading timed out after ${timeoutMs}ms`,
  );
  const text = normalizeImageReadingText(response);
  return text ? { text, provider: "workers-ai", model } : null;
}

export async function readImageWithPiAi(
  request: ImageReadingRequest & { provider: string },
): Promise<ImageReadingResult | null> {
  const provider = normalizeOptionalText(request.provider);
  if (!provider) {
    return null;
  }
  if (isWorkersAiProvider(provider)) {
    throw new Error("Workers AI image reading requires the Workers AI binding path");
  }

  const modelName = normalizeOptionalText(request.model);
  if (!modelName) {
    return null;
  }

  const base64 = normalizeBase64Data(request.data);
  if (!base64) {
    return null;
  }

  const model = resolvePiAiModel(provider, modelName);
  const timeoutMs = normalizePositiveNumber(request.timeoutMs) ?? DEFAULT_IMAGE_READING_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Image reading timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await withTimeout(
      completePiAiSimple(model, buildImageReadingContext({
        data: base64,
        mimeType: request.mimeType,
        prompt: normalizeOptionalText(request.prompt) || DEFAULT_IMAGE_READING_PROMPT,
      }), {
        apiKey: normalizeOptionalText(request.apiKey),
        maxTokens: normalizePositiveNumber(request.maxTokens) ?? DEFAULT_IMAGE_READING_MAX_TOKENS,
        signal: controller.signal,
        timeoutMs,
      }),
      timeoutMs,
      `Image reading timed out after ${timeoutMs}ms`,
    );
    const text = extractAssistantText(response);
    return text ? { text, provider, model: modelName } : null;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeImageReadingText(value: unknown): string | null {
  const text = firstText(value);
  return text ? text.replace(/\s+/g, " ").trim() : null;
}

export function normalizeImageReadingInputFormat(value: unknown): ImageReadingInputFormat | null {
  if (value !== "auto" && value !== "chat" && value !== "image") {
    return null;
  }
  return value;
}

function resolveImageReadingInputFormat(
  value: unknown,
  model: string,
): Exclude<ImageReadingInputFormat, "auto"> {
  const inputFormat = normalizeImageReadingInputFormat(value) ?? DEFAULT_IMAGE_READING_INPUT_FORMAT;
  if (inputFormat === "image" || inputFormat === "chat") {
    return inputFormat;
  }
  return /(^|\/)llava(?:-|\/|\.)/i.test(model) || /llava/i.test(model) ? "image" : "chat";
}

function buildImagePromptInput(bytes: number[], prompt: string, maxTokens: number): Record<string, unknown> {
  return {
    image: bytes,
    prompt,
    max_tokens: maxTokens,
  };
}

function buildChatVisionInput(
  base64: string,
  mimeType: string | undefined,
  prompt: string,
  maxTokens: number,
): Record<string, unknown> {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${normalizeImageMimeType(mimeType)};base64,${base64}`,
              detail: "auto",
            },
          },
        ],
      },
    ],
    max_completion_tokens: maxTokens,
    chat_template_kwargs: {
      enable_thinking: false,
      clear_thinking: true,
    },
  };
}

function buildImageReadingContext(input: {
  data: string;
  mimeType?: string;
  prompt: string;
}): Context {
  return {
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [
          { type: "text", text: input.prompt },
          {
            type: "image",
            data: input.data,
            mimeType: normalizeImageMimeType(input.mimeType),
          },
        ],
      },
    ],
  };
}

function extractAssistantText(message: AssistantMessage): string {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (text) {
    return text;
  }

  return message.content
    .filter((block): block is ThinkingContent => block.type === "thinking")
    .map((block) => block.thinking)
    .join("")
    .trim();
}

function firstText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const candidate of [
    record.description,
    record.response,
    record.content,
    record.text,
    record.output,
    record.result,
    record.caption,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  if (Array.isArray(record.choices)) {
    for (const item of record.choices) {
      const text = firstText(item);
      if (text) {
        return text;
      }
    }
  }

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const text = firstText(item);
      if (text) {
        return text;
      }
    }
  }

  if (record.message && typeof record.message === "object") {
    return firstText(record.message);
  }

  if (record.delta && typeof record.delta === "object") {
    return firstText(record.delta);
  }

  return null;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeImageMimeType(value: unknown): string {
  const normalized = normalizeOptionalText(value);
  return normalized && normalized.startsWith("image/") ? normalized : "image/png";
}
