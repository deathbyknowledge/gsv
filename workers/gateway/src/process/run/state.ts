import { z } from "zod";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import {
  aiToolsDeviceSchema,
  processIdentitySchema,
  responsibilityBatchSchema,
} from "../internal/schemas";

const aiModelConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  providerStyle: z.string().optional(),
  transportTarget: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
}).strict();
const aiTextGenerateConfigSchema = z.object({
  modelConfig: aiModelConfigSchema.optional(),
  modelId: z.string().optional(),
  reasoning: z.string().optional(),
}).strict();
const toolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: jsonObjectSchema,
});
const aiTextExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("process"), pid: z.string() }),
  z.object({ kind: z.literal("kernel") }),
  z.object({ kind: z.literal("device"), target: z.string() }),
]);
const aiRuntimeSchemaFields = {
  provider: z.string(),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  providerStyle: z.string().optional(),
  transportTarget: z.string().optional(),
  openAiCodex: z.object({ accountId: z.string().optional() }).optional(),
  reasoning: z.string().optional(),
  maxTokens: z.number(),
  contextWindowTokens: z.number().nullable(),
  contextWindowSource: z.enum(["model", "config", "unknown"]),
  generationTimeoutMs: z.number().default(180_000),
  generationStreaming: z.enum(["auto", "off"]).optional(),
};
const aiConfigFallbackSchema = z.object({
  modelId: z.string().optional(),
  modelName: z.string().optional(),
  ...aiRuntimeSchemaFields,
});
const aiConfigResultSchema = z.object({
  owner: processIdentitySchema.nullable().optional(),
  executor: aiTextExecutorSchema,
  ...aiRuntimeSchemaFields,
  systemContextFiles: z.array(z.object({
    name: z.string(),
    text: z.string(),
  })).optional(),
  system: z.object({ timezone: z.string() }).optional(),
  skillIndex: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    source: z.object({
      kind: z.literal("home"),
      label: z.string(),
      writable: z.boolean(),
    }),
  })).optional(),
  skillIndexMode: z.enum(["summary", "names", "off"]).optional(),
  accountApprovalPolicy: z.string().nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  maxContextBytes: z.number(),
  fallbacks: z.array(aiConfigFallbackSchema).optional(),
  media: z.object({
    transcriptionProvider: z.string(),
    transcriptionModel: z.string(),
    transcriptionApiKey: z.string(),
    transcriptionMaxBytes: z.number(),
    imageReadingMaxBytes: z.number(),
    imageReadingMaxTokens: z.number(),
    imageReadingMaxObjects: z.number(),
    imageReadingTimeoutMs: z.number(),
    imageGenerationProvider: z.string(),
    imageGenerationModel: z.string(),
    imageGenerationApiKey: z.string(),
    speechProvider: z.string(),
    speechModel: z.string(),
    speechApiKey: z.string(),
    speechSpeaker: z.string(),
    speechEncoding: z.string(),
    speechMaxChars: z.number(),
    speechTimeoutMs: z.number(),
  }).optional(),
});
const toolApprovalPolicySchema = z.object({
  default: z.enum(["auto", "ask", "deny"]),
  rules: z.array(z.object({
    match: z.string(),
    target: z.string().optional(),
    action: z.enum(["auto", "ask", "deny"]),
  })),
});
const processMediaInputSchema = z.object({
  type: z.enum(["image", "audio", "video", "document"]),
  mimeType: z.string(),
  key: z.string().optional(),
  conversationId: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  filename: z.string().optional(),
  size: z.number().optional(),
  duration: z.number().optional(),
  transcription: z.string().optional(),
});

export const runOutputMediaSchema = processMediaInputSchema.extend({
  key: z.string(),
  path: z.string(),
  size: z.number(),
  revision: z.string().optional(),
});

const responsibilityBatchStateSchema = responsibilityBatchSchema.extend({
  ledgerRevision: z.number().int().nonnegative().safe().optional(),
});

export const runStateSchema = z.object({
  runId: z.string(),
  returnToCaller: z.boolean().optional(),
  conversationId: z.string().optional(),
  inputMessageId: z.string().optional(),
  tickGeneration: z.number().optional(),
  pendingMediaMessageId: z.number().optional(),
  pendingRuntimeEvents: z.number().optional(),
  responsibilityBatches: z.array(responsibilityBatchStateSchema).optional(),
  offeredToolNames: z.array(z.string()).optional(),
  terminalCorrectionRounds: z.number().optional(),
  terminalCommandFailures: z.number().optional(),
  terminalDeliveryFailures: z.number().optional(),
  config: aiConfigResultSchema.optional(),
  aiTextGenerateConfig: aiTextGenerateConfigSchema.optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  devices: z.array(aiToolsDeviceSchema).optional(),
  mcpServers: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  contextEpochId: z.string().optional(),
  generationContextId: z.string().optional(),
  approvalPolicy: toolApprovalPolicySchema.optional(),
  outputMedia: z.array(runOutputMediaSchema).optional(),
  stagedOutputMediaKeys: z.array(z.string()).optional(),
  outputMediaPersisted: z.boolean().optional(),
});

export type ResponsibilityBatchState = z.infer<typeof responsibilityBatchStateSchema>;
export type RunOutputMedia = z.infer<typeof runOutputMediaSchema>;
export type RunState = z.infer<typeof runStateSchema>;
