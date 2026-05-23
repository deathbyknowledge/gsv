import { env } from "cloudflare:workers";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { isTimeoutError, withTimeout } from "./timeout";

export const WORKERS_AI_PROVIDER = "workers-ai";
export const WORKERS_AI_PROVIDER_ALIAS = "workersai";
export const DEFAULT_WORKERS_AI_MODEL = "@cf/nvidia/nemotron-3-120b-a12b";

const WORKERS_AI_API = "workers-ai-binding";
const DEFAULT_INPUT_COST_PER_MILLION = 0.5;
const DEFAULT_OUTPUT_COST_PER_MILLION = 1.5;

type WorkersAiMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: WorkersAiToolCall[];
};

type WorkersAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: {
      type: "object";
      properties: Record<string, {
        type: string;
        description?: string;
      }>;
      required: string[];
    };
    strict: boolean | null;
  };
};

type WorkersAiRunInput = AiTextGenerationInput & {
  messages: WorkersAiMessage[];
  max_completion_tokens?: number;
  tools?: WorkersAiTool[];
  parallel_tool_calls?: boolean;
  reasoning_effort?: Exclude<ThinkingLevel, "off">;
  chat_template_kwargs?: {
    enable_thinking?: boolean;
    clear_thinking?: boolean;
  };
};

type WorkersAiRunOutput = AiTextGenerationOutput & Record<string, unknown>;

type WorkersAiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type DynamicWorkersAiBinding = Ai<Record<string, {
  inputs: WorkersAiRunInput;
  postProcessedOutputs: WorkersAiRunOutput;
}>>;

type WorkersAiCatalogProperty = {
  property_id: string;
  value: string;
};

type WorkersAiCatalogModel = {
  id: string;
  name?: string;
  description?: string;
  properties?: WorkersAiCatalogProperty[];
};

type WorkersAiCatalogBinding = {
  models(params?: {
    author?: string;
    hide_experimental?: boolean;
    page?: number;
    per_page?: number;
    search?: string;
    source?: number;
    task?: string;
  }): Promise<WorkersAiCatalogModel[]>;
};

const workersAiContextWindowCache = new Map<string, Promise<number | null>>();

export type WorkersAiRequest = {
  modelName: string;
  context: Context;
  reasoning?: ThinkingLevel;
  maxTokens: number;
  sessionAffinityKey?: string;
  timeoutMs?: number;
};

type WorkersAiRunOptions = AiOptions & {
  headers?: HeadersInit;
};

export function isWorkersAiProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === WORKERS_AI_PROVIDER || normalized === WORKERS_AI_PROVIDER_ALIAS;
}

export function extractWorkersAiContextWindow(model: WorkersAiCatalogModel): number | null {
  for (const property of model.properties ?? []) {
    if (!isContextWindowPropertyId(property.property_id)) continue;
    const tokens = parseTokenQuantity(property.value);
    if (tokens !== null) {
      return tokens;
    }
  }

  return parseContextWindowDescription(model.description ?? "");
}

export async function resolveWorkersAiModelContextWindow(modelName: string): Promise<number | null> {
  const cacheKey = normalizeWorkersAiModelName(modelName);
  const cached = workersAiContextWindowCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = lookupWorkersAiModelContextWindow(modelName);
  workersAiContextWindowCache.set(cacheKey, lookup);
  return lookup;
}

export async function completeWithWorkersAi(
  request: WorkersAiRequest,
): Promise<AssistantMessage> {
  const ai = env.AI as unknown as DynamicWorkersAiBinding | undefined;
  if (!ai) {
    throw new Error("Workers AI binding is not configured for this worker");
  }

  const primaryInput = buildWorkersAiInput(request);
  const runOptions = buildWorkersAiRunOptions(request);

  try {
    const response = await runWorkersAiWithTimeout(
      ai,
      request.modelName,
      primaryInput,
      runOptions,
      request.timeoutMs,
    );
    return normalizeWorkersAiResponse(response, request.modelName);
  } catch (error) {
    if (primaryInput.tools && primaryInput.tools.length > 0 && !shouldSkipNoToolsFallback(error)) {
      const fallbackInput = buildWorkersAiInput(request, { disableTools: true });
      try {
        const fallbackResponse = await runWorkersAiWithTimeout(
          ai,
          request.modelName,
          fallbackInput,
          runOptions,
          request.timeoutMs,
        );
        return normalizeWorkersAiResponse(fallbackResponse, request.modelName);
      } catch {
      }
    }

    throw error;
  }
}

function shouldSkipNoToolsFallback(error: unknown): boolean {
  return isTimeoutError(error)
    || (error instanceof Error && error.name === "AbortError");
}

function runWorkersAiWithTimeout(
  ai: DynamicWorkersAiBinding,
  modelName: string,
  input: WorkersAiRunInput,
  options: WorkersAiRunOptions | undefined,
  timeoutMs: number | undefined,
): Promise<WorkersAiRunOutput> {
  const run = ai.run(modelName, input, options);
  return withTimeout(
    run,
    timeoutMs ?? 0,
    `Workers AI generation timed out after ${timeoutMs}ms`,
  );
}

async function lookupWorkersAiModelContextWindow(modelName: string): Promise<number | null> {
  const ai = env.AI as unknown as WorkersAiCatalogBinding | undefined;
  if (!ai || typeof ai.models !== "function") {
    return null;
  }

  try {
    for (const search of workersAiModelSearchTerms(modelName)) {
      const models = await ai.models({
        search,
        per_page: 50,
      });
      const exact = models.find((candidate) => isWorkersAiModelMatch(candidate, modelName));
      const contextWindow = exact ? extractWorkersAiContextWindow(exact) : null;
      if (contextWindow !== null) {
        return contextWindow;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function workersAiModelSearchTerms(modelName: string): string[] {
  const lastSegment = modelName.split("/").filter(Boolean).at(-1);
  return Array.from(new Set([
    modelName,
    lastSegment ?? modelName,
  ].map((term) => term.trim()).filter((term) => term.length > 0)));
}

function isWorkersAiModelMatch(model: WorkersAiCatalogModel, modelName: string): boolean {
  const requested = normalizeWorkersAiModelName(modelName);
  return [
    model.id,
    model.name,
  ].some((candidate) => candidate !== undefined && normalizeWorkersAiModelName(candidate) === requested);
}

function normalizeWorkersAiModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@cf\//, "");
}

function isContextWindowPropertyId(propertyId: string): boolean {
  const normalized = propertyId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("context") &&
    (normalized.includes("window") ||
      normalized.includes("token") ||
      normalized.includes("length"))
  ) || (
    normalized.includes("max") &&
    normalized.includes("input") &&
    normalized.includes("token")
  );
}

function parseContextWindowDescription(description: string): number | null {
  const normalized = description.replace(/,/g, "");
  const patterns = [
    /(\d+(?:\.\d+)?)\s*k\s*(?:token\s*)?context window/i,
    /(\d+(?:\.\d+)?)\s*(?:token|tokens)\s*context window/i,
    /context window[^.]{0,80}?(\d+(?:\.\d+)?)\s*k/i,
    /up to\s+(\d+(?:\.\d+)?)\s*k\s*tokens/i,
    /up to\s+(\d+(?:\.\d+)?)\s*(?:token|tokens)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const tokens = match ? parseTokenQuantity(match[0]) : null;
    if (tokens !== null) {
      return tokens;
    }
  }

  return null;
}

function parseTokenQuantity(value: string): number | null {
  const normalized = value.toLowerCase().replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([km])?\b/);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const multiplier = match[2] === "m"
    ? 1_000_000
    : match[2] === "k"
      ? 1_000
      : 1;
  const tokens = Math.round(amount * multiplier);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

export function buildWorkersAiInput(
  request: WorkersAiRequest,
  options?: { disableTools?: boolean },
): WorkersAiRunInput {
  const input: WorkersAiRunInput = {
    messages: contextToWorkersAiMessages(request.context) as unknown as WorkersAiRunInput["messages"],
    max_completion_tokens: request.maxTokens,
  };

  const tools = options?.disableTools ? [] : contextToWorkersAiTools(request.context);
  if (tools.length > 0) {
    input.tools = tools;
    input.parallel_tool_calls = true;
  }

  if (request.reasoning) {
    input.reasoning_effort = request.reasoning;
    input.chat_template_kwargs = {
      enable_thinking: true,
    };
  } else {
    input.chat_template_kwargs = {
      enable_thinking: false,
      clear_thinking: true,
    };
  }

  return input;
}

export function buildWorkersAiRunOptions(
  request: WorkersAiRequest,
): WorkersAiRunOptions | undefined {
  const sessionAffinityKey = request.sessionAffinityKey?.trim();
  if (!sessionAffinityKey) {
    return undefined;
  }

  return {
    headers: {
      "x-session-affinity": sessionAffinityKey,
    },
  };
}

export function contextToWorkersAiMessages(context: Context): WorkersAiMessage[] {
  const messages: WorkersAiMessage[] = [];

  const systemPrompt = context.systemPrompt?.trim();
  if (systemPrompt) {
    messages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  for (const message of context.messages) {
    messages.push(...convertMessage(message));
  }

  return messages;
}

export function contextToWorkersAiTools(context: Context): WorkersAiTool[] {
  return (context.tools ?? []).map(convertTool);
}

export function normalizeWorkersAiResponse(
  response: WorkersAiRunOutput,
  modelName: string,
): AssistantMessage {
  const thinking = extractWorkersAiThinking(response);
  const text = extractWorkersAiText(response);
  const toolCalls = extractWorkersAiToolCalls(response);
  const content: Array<TextContent | ThinkingContent | ToolCall> = [];

  if (thinking) {
    content.push({
      type: "thinking",
      thinking,
    });
  }

  if (text) {
    content.push({
      type: "text",
      text,
    });
  }

  content.push(...toolCalls);

  const usage = {
    input: asNumber(response.usage?.prompt_tokens),
    output: asNumber(response.usage?.completion_tokens),
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: asNumber(response.usage?.total_tokens),
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };

  if (usage.totalTokens === 0) {
    usage.totalTokens = usage.input + usage.output;
  }

  if (modelName === DEFAULT_WORKERS_AI_MODEL) {
    usage.cost.input = (DEFAULT_INPUT_COST_PER_MILLION / 1_000_000) * usage.input;
    usage.cost.output = (DEFAULT_OUTPUT_COST_PER_MILLION / 1_000_000) * usage.output;
    usage.cost.total = usage.cost.input + usage.cost.output;
  }

  let stopReason: AssistantMessage["stopReason"] = "stop";
  let errorMessage: string | undefined;

  if (toolCalls.length > 0) {
    stopReason = "toolUse";
  } else if (!text) {
    stopReason = "error";
    errorMessage = "Workers AI returned an empty response";
  }

  return {
    role: "assistant",
    content,
    api: WORKERS_AI_API,
    provider: WORKERS_AI_PROVIDER,
    model: modelName,
    usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function convertMessage(message: Message): WorkersAiMessage[] {
  switch (message.role) {
    case "user":
      return [convertUserMessage(message)];
    case "assistant":
      return convertAssistantMessage(message);
    case "toolResult":
      return [convertToolResultMessage(message)];
  }
}

function convertUserMessage(message: UserMessage): WorkersAiMessage {
  return {
    role: "user",
    content: serializeUserContent(message.content),
  };
}

function convertAssistantMessage(message: Extract<Message, { role: "assistant" }>): WorkersAiMessage[] {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolCalls: WorkersAiToolCall[] = [];

  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    toolCalls.push({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
      },
    });
  }

  return [{
    role: "assistant",
    content: text || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  }];
}

function convertToolResultMessage(message: ToolResultMessage): WorkersAiMessage {
  return {
    role: "tool",
    content: serializeTextBlocks(message.content),
    tool_call_id: message.toolCallId,
  };
}

function convertTool(tool: Tool): WorkersAiTool {
  const schema = sanitizeToolParameters(tool.parameters as unknown as Record<string, unknown>);
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: schema,
      strict: false,
    },
  };
}

function serializeUserContent(
  content: UserMessage["content"],
): string {
  if (typeof content === "string") return content;
  return serializeTextBlocks(content);
}

function serializeTextBlocks(
  blocks: Array<TextContent | ImageContent>,
): string {
  const text = blocks.flatMap((block) => {
    if (block.type === "text") return [block.text];
    return ["[The user tried to attach an image but the current model has no multi-modality capabilities]"];
  }).join("");

  return text;
}

function normalizeWorkersAiToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.flatMap((toolCall, index) => {
    if (!toolCall || typeof toolCall !== "object") return [];

    const openAiStyle = toolCall as {
      id?: unknown;
      function?: {
        name?: unknown;
        arguments?: unknown;
      };
      name?: unknown;
      arguments?: unknown;
    };

    const name = asString(openAiStyle.function?.name) ?? asString(openAiStyle.name);
    if (!name) return [];

    const id = asString(openAiStyle.id) ?? `workers-ai-tool-${index + 1}`;
    const argumentsInput = openAiStyle.function?.arguments ?? openAiStyle.arguments;

    return [{
      type: "toolCall",
      id,
      name,
      arguments: parseToolArguments(argumentsInput),
    }];
  });
}

function extractWorkersAiText(response: WorkersAiRunOutput): string {
  if (typeof response.response === "string" && response.response.length > 0) {
    return response.response;
  }

  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }

  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choiceText = choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const message = (choice as { message?: unknown }).message;
      return extractChoiceMessageText(message);
    })
    .join("");
  if (choiceText) {
    return choiceText;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const outputText = output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const type = (entry as { type?: unknown }).type;
        const text = (entry as { text?: unknown }).text;
        if (type === "output_text" && typeof text === "string") {
          return [text];
        }
        return [];
      });
    })
    .join("");

  return outputText;
}

function extractWorkersAiThinking(response: WorkersAiRunOutput): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choiceReasoning = choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const message = (choice as { message?: unknown }).message;
      return extractChoiceMessageThinking(message);
    })
    .join("");
  if (choiceReasoning) {
    return choiceReasoning;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const outputReasoning = output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const type = (item as { type?: unknown }).type;
      if (type !== "reasoning") return [];

      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const contentReasoning = content.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const entryType = (entry as { type?: unknown }).type;
          const text = (entry as { text?: unknown }).text;
          if (entryType === "reasoning_text" && typeof text === "string") {
            return [text];
          }
          return [];
        }).join("");
        if (contentReasoning) {
          return [contentReasoning];
        }
      }

      const summary = (item as { summary?: unknown }).summary;
      if (Array.isArray(summary)) {
        const summaryReasoning = summary.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const entryType = (entry as { type?: unknown }).type;
          const text = (entry as { text?: unknown }).text;
          if (entryType === "summary_text" && typeof text === "string") {
            return [text];
          }
          return [];
        }).join("");
        if (summaryReasoning) {
          return [summaryReasoning];
        }
      }

      return [];
    })
    .join("\n");

  return outputReasoning;
}

function extractWorkersAiToolCalls(response: WorkersAiRunOutput): ToolCall[] {
  const fromTopLevel = normalizeWorkersAiToolCalls(response.tool_calls);
  if (fromTopLevel.length > 0) {
    return fromTopLevel;
  }

  const choices = Array.isArray(response.choices) ? response.choices : [];
  const fromChoices = choices.flatMap((choice) => {
    if (!choice || typeof choice !== "object") return [];
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") return [];
    return normalizeWorkersAiToolCalls((message as { tool_calls?: unknown }).tool_calls);
  });
  if (fromChoices.length > 0) {
    return fromChoices;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const fromOutput = output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const type = (item as { type?: unknown }).type;
    if (type !== "function_call") return [];
    const id = asString((item as { call_id?: unknown }).call_id)
      ?? asString((item as { id?: unknown }).id)
      ?? "workers-ai-tool-1";
    const name = asString((item as { name?: unknown }).name);
    const argumentsInput = (item as { arguments?: unknown }).arguments;
    if (!name) return [];
    return [{
      type: "toolCall" as const,
      id,
      name,
      arguments: parseToolArguments(argumentsInput),
    }];
  });

  return fromOutput;
}

function extractChoiceMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const type = (entry as { type?: unknown }).type;
      const text = (entry as { text?: unknown }).text;
      if (type === "text" && typeof text === "string") {
        return [text];
      }
      return [];
    }).join("");
  }

  return "";
}

function extractChoiceMessageThinking(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  const reasoningContent = (message as { reasoning_content?: unknown }).reasoning_content;
  if (typeof reasoningContent === "string") {
    return reasoningContent;
  }

  const reasoning = (message as { reasoning?: unknown }).reasoning;
  if (typeof reasoning === "string") {
    return reasoning;
  }
  if (Array.isArray(reasoning)) {
    return reasoning.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!entry || typeof entry !== "object") return [];
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }).join("");
  }
  if (reasoning && typeof reasoning === "object") {
    const summary = (reasoning as { summary?: unknown }).summary;
    if (typeof summary === "string") {
      return summary;
    }
    if (Array.isArray(summary)) {
      return summary.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (!entry || typeof entry !== "object") return [];
        const text = (entry as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      }).join("");
    }
  }

  return "";
}

function sanitizeToolParameters(
  schema: Record<string, unknown> | undefined,
): WorkersAiTool["function"]["parameters"] | undefined {
  if (!schema || schema.type !== "object") return undefined;

  const propertiesInput = schema.properties;
  const requiredInput = schema.required;
  const properties: NonNullable<WorkersAiTool["function"]["parameters"]>["properties"] = {};

  if (propertiesInput && typeof propertiesInput === "object" && !Array.isArray(propertiesInput)) {
    for (const [key, value] of Object.entries(propertiesInput)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const property = value as { type?: unknown; description?: unknown };
      if (typeof property.type !== "string") continue;
      properties[key] = {
        type: property.type,
        description: typeof property.description === "string" ? property.description : undefined,
      };
    }
  }

  return {
    type: "object",
    properties,
    required: Array.isArray(requiredInput)
      ? requiredInput.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function parseToolArguments(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string") {
    return { value: input };
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: input };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
