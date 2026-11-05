import { z } from "zod";
import { jsonObjectSchema, toolApprovalTargetSchema } from "@humansandmachines/gsv/protocol";
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
  system: z.object({ timezone: z.string(), language: z.string().optional() }).optional(),
  skillIndex: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    source: z.object({
      kind: z.enum(["system", "home"]),
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
    target: toolApprovalTargetSchema.optional(),
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

// Keyed by the wake batch or event that handed these responsibilities to the run.
const responsibilityBatchStateSchema = responsibilityBatchSchema.extend({
  batchId: z.string().trim().regex(/^[a-zA-Z0-9._:-]{1,200}$/u),
  ledgerRevision: z.number().int().nonnegative().safe().optional(),
});

export const runStateSchema = z.object({
  runId: z.string(),
  continuation: z.literal(true).optional(),
  returnToCaller: z.boolean().optional(),
  conversationId: z.string().optional(),
  inputMessageId: z.string().optional(),
  /** When the person's message that started this run reached the Process. */
  inputAt: z.number().int().nonnegative().optional(),
  /** Set once the run has committed its first message, so reply timing is measured once. */
  replied: z.literal(true).optional(),
  tickGeneration: z.number().optional(),
  generationRetryRevision: z.number().int().nonnegative().safe().optional(),
  pendingMediaMessageId: z.number().optional(),
  pendingRuntimeEvents: z.number().optional(),
  responsibilityBatches: z.array(responsibilityBatchStateSchema).optional(),
  offeredToolNames: z.array(z.string()).optional(),
  terminalCorrectionRounds: z.number().optional(),
  /** Reads the person approved in this run, as `target\0path`: that approval carries to a Send that attaches the same file. */
  approvedReads: z.array(z.string()).optional(),
  terminalCommandFailures: z.number().optional(),
  terminalDeliveryFailures: z.number().optional(),
  /** The message this run sent when the responsibilities refused its yield; a repeat of it only asks to yield again. */
  blockedYieldText: z.string().optional(),
  config: aiConfigResultSchema.optional(),
  aiTextGenerateConfig: aiTextGenerateConfigSchema.optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  toolSyscalls: z.record(z.string(), z.string()).optional(),
  devices: z.array(aiToolsDeviceSchema).optional(),
  mcpServers: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  contextEpochId: z.string().optional(),
  pendingCompaction: z.object({
    summary: z.string(),
    throughMessageId: z.number().int().positive(),
    historyGeneration: z.number().int(),
    contextEpochId: z.string(),
  }).optional(),
  generationContextId: z.string().optional(),
  approvalPolicy: toolApprovalPolicySchema.optional(),
  outputMedia: z.array(runOutputMediaSchema).optional(),
  stagedOutputMediaKeys: z.array(z.string()).optional(),
  /** Tool calls that were running when this run sent elsewhere without files; they may not stage reply files. */
  stagingFences: z.array(z.object({ dispatchId: z.string(), destination: z.string() })).optional(),
  outputMediaPersisted: z.boolean().optional(),
});

export type ResponsibilityBatchState = z.infer<typeof responsibilityBatchStateSchema>;
export type RunOutputMedia = z.infer<typeof runOutputMediaSchema>;
export type RunState = z.infer<typeof runStateSchema>;
