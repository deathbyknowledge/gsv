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
} from "@mariozechner/pi-ai";

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

export type WorkersAiRequest = {
  modelName: string;
  context: Context;
  reasoning?: ThinkingLevel;
  maxTokens: number;
  sessionAffinityKey?: string;
};

type WorkersAiRunOptions = AiOptions & {
  headers?: HeadersInit;
};

export function isWorkersAiProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === WORKERS_AI_PROVIDER || normalized === WORKERS_AI_PROVIDER_ALIAS;
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
  console.log(
    `[WorkersAI] request ${JSON.stringify(summarizeRunInput(request.modelName, primaryInput, request.sessionAffinityKey))}`,
  );

  try {
    const response = await ai.run(request.modelName, primaryInput, runOptions);
    console.log(
      `[WorkersAI] response ${JSON.stringify(summarizeRunOutput(response))}`,
    );
    return normalizeWorkersAiResponse(response, request.modelName);
  } catch (error) {
    console.error(
      `[WorkersAI] primary request failed ${JSON.stringify(serializeError(error))}`,
    );

    if (primaryInput.tools && primaryInput.tools.length > 0) {
      const fallbackInput = buildWorkersAiInput(request, { disableTools: true });
      console.warn(
        `[WorkersAI] retrying without tools ${JSON.stringify(summarizeRunInput(request.modelName, fallbackInput, request.sessionAffinityKey))}`,
      );
      try {
        const fallbackResponse = await ai.run(request.modelName, fallbackInput, runOptions);
        console.warn(
          `[WorkersAI] fallback without tools succeeded ${JSON.stringify(summarizeRunOutput(fallbackResponse))}`,
        );
        return normalizeWorkersAiResponse(fallbackResponse, request.modelName);
      } catch (fallbackError) {
        console.error(
          `[WorkersAI] fallback without tools failed ${JSON.stringify(serializeError(fallbackError))}`,
        );
      }
    }

    throw error;
  }
}

export function buildWorkersAiInput(
  request: WorkersAiRequest,
  options?: { disableTools?: boolean },
): WorkersAiRunInput {
  const input: WorkersAiRunInput = {
    messages: contextToWorkersAiMessages(request.context),
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
    throw new Error("Workers AI text generation does not support image content in this context");
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
  const properties: WorkersAiTool["parameters"]["properties"] = {};

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

function summarizeRunInput(
  modelName: string,
  input: WorkersAiRunInput,
  sessionAffinityKey?: string,
) {
  return {
    model: modelName,
    sessionAffinityKey: sessionAffinityKey ?? null,
    messageCount: input.messages.length,
    messageRoles: input.messages.map((message) => ({
      role: message.role,
      contentLength: typeof message.content === "string" ? message.content.length : 0,
      toolCalls: message.tool_calls?.length ?? 0,
      hasToolCallId: !!message.tool_call_id,
    })),
    toolCount: input.tools?.length ?? 0,
    tools: input.tools?.map((tool) => ({
      name: tool.function.name,
      required: tool.function.parameters?.required ?? [],
      propertyCount: Object.keys(tool.function.parameters?.properties ?? {}).length,
      strict: tool.function.strict,
    })) ?? [],
    maxCompletionTokens: input.max_completion_tokens ?? null,
    reasoningEffort: input.reasoning_effort ?? null,
    parallelToolCalls: input.parallel_tool_calls ?? null,
  };
}

function summarizeRunOutput(response: WorkersAiRunOutput) {
  const choices = Array.isArray(response.choices) ? response.choices : [];

  return {
    keys: Object.keys(response).sort(),
    responseTextLength: typeof response.response === "string" ? response.response.length : 0,
    outputTextLength: typeof response.output_text === "string" ? response.output_text.length : 0,
    extractedThinkingLength: extractWorkersAiThinking(response).length,
    extractedTextLength: extractWorkersAiText(response).length,
    topLevelToolCallCount: Array.isArray(response.tool_calls) ? response.tool_calls.length : 0,
    extractedToolCallCount: extractWorkersAiToolCalls(response).length,
    choiceCount: choices.length,
    finishReasons: choices.map((choice) =>
      choice && typeof choice === "object"
        ? asString((choice as { finish_reason?: unknown }).finish_reason) ?? null
        : null,
    ),
    choiceMessages: choices.map((choice) => summarizeChoiceMessage(
      choice && typeof choice === "object"
        ? (choice as { message?: unknown }).message
        : undefined,
    )),
    outputCount: Array.isArray(response.output) ? response.output.length : 0,
    usage: response.usage ?? null,
    completionTokensDetails:
      response.usage && typeof response.usage === "object"
        ? (response.usage as { completion_tokens_details?: unknown }).completion_tokens_details ?? null
        : null,
  };
}

function summarizeChoiceMessage(message: unknown) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const content = (message as { content?: unknown }).content;
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;

  return {
    keys: Object.keys(message as Record<string, unknown>).sort(),
    contentType: Array.isArray(content) ? "array" : typeof content,
    contentPartTypes: Array.isArray(content)
      ? content.map((entry) =>
        entry && typeof entry === "object"
          ? asString((entry as { type?: unknown }).type) ?? "object"
          : typeof entry,
      )
      : [],
    contentTextLength: extractChoiceMessageText(message).length,
    reasoningLength: extractChoiceMessageThinking(message).length,
    refusalLength: typeof (message as { refusal?: unknown }).refusal === "string"
      ? ((message as { refusal?: string }).refusal?.length ?? 0)
      : 0,
    toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
  };
}

function serializeError(error: unknown) {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }

  const value = error as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
    stack?: unknown;
    code?: unknown;
    status?: unknown;
  };

  const ownProps = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key) => {
      const property = (error as Record<string, unknown>)[key];
      if (typeof property === "string" || typeof property === "number" || typeof property === "boolean" || property === null) {
        return [key, property];
      }
      return [key, typeof property];
    }),
  );

  return {
    name: typeof value.name === "string" ? value.name : undefined,
    message: typeof value.message === "string" ? value.message : String(error),
    code: value.code,
    status: value.status,
    cause: value.cause,
    ownProps,
    stack: typeof value.stack === "string" ? value.stack.split("\n").slice(0, 4).join("\n") : undefined,
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
