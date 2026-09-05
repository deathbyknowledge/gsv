/** Internal Process schemas primitives. */

import type { CodeModeExecArgs } from "../../syscalls/codemode";
import { RUN_CONTROL_INSTRUCTION } from "./lifecycle";
import type { Tool } from "@earendil-works/pi-ai";
import { jsonObjectSchema, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { processIdentitySchema } from "../../protocol/peer-schemas";

export { processIdentitySchema };

export const nonEmptyStringSchema = z.string().trim().min(1);

export const aiToolsDeviceSchema = z.object({
  id: z.string(),
  implements: z.array(z.string()),
  label: z.string().optional(),
  description: z.string().optional(),
  platform: z.string().optional(),
});

export const piToolParametersSchema = z.custom<Tool["parameters"]>(
  (value) => jsonObjectSchema.safeParse(value).success,
);

export const RUN_CONTROL_SHELL_TOOL: Tool = {
  name: "Shell",
  description: `Run a GSV shell command. ${RUN_CONTROL_INSTRUCTION}`,
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The message or run-control command to run on GSV.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  },
};

export const routedFetchOptionsSchema = z.object({
  timeoutMs: z.number().optional(),
}).passthrough();

export const cancelRequestPayloadSchema = z.object({
  id: z.string(),
  reason: z.string().optional(),
});

export const storedStringArraySchema = z.array(z.string());

export type CancelRequestPayload = z.infer<typeof cancelRequestPayloadSchema>;

export const codeModeExecArgsSchema: z.ZodType<CodeModeExecArgs> = z.object({
  code: z.string(),
});

export const exactBodyLengthSchema = z.number().int().nonnegative().safe();

export const storedHistoryPolicySchema = z.object({
  overflow: z.enum(["auto-compact", "fail"]).optional().catch(undefined),
  compactAtPressure: z.number().finite().optional().catch(undefined),
  compactToPressure: z.number().finite().optional().catch(undefined),
  updatedAt: z.number().finite().optional().catch(undefined),
});

export const workReturnedRuntimeEventSchema = z.strictObject({
  type: z.literal("adapter.work.returned"),
  workPid: z.string().trim().regex(/^[a-zA-Z0-9._:-]{1,200}$/u),
});

export const responsibilityBatchSchema = z.strictObject({
  batchId: z.string().trim().regex(/^batch:[0-9a-f-]{36}$/u),
  ledgerRevision: z.number().int().nonnegative().safe(),
  responsibilityIds: z.array(
    z.string().trim().regex(/^r12y:[0-9a-f-]{36}$/u),
  ).min(1).max(100),
});

export const responsibilityReadyRuntimeEventSchema = responsibilityBatchSchema.extend({
  type: z.literal("r12y.ready"),
});

export const processRuntimeEventSchema = z.discriminatedUnion("type", [
  workReturnedRuntimeEventSchema,
  responsibilityReadyRuntimeEventSchema,
]);

const federationResponsibilityBaseSchema = {
  contactId: z.string(),
  contactGeneration: z.string(),
  conversationId: z.string(),
  remoteDisplayName: z.string().optional(),
};

export const federationResponsibilityDetailsSchema = z.discriminatedUnion("eventType", [
  z.strictObject({
    ...federationResponsibilityBaseSchema,
    eventType: z.literal("federation.message.received"),
    deliveryId: z.string(),
    messageId: z.string(),
    resourceCount: z.number().int().nonnegative(),
    contentTrust: z.literal("untrusted"),
  }),
  z.strictObject({
    ...federationResponsibilityBaseSchema,
    eventType: z.literal("federation.request"),
    requestId: z.string(),
    direction: z.enum(["incoming", "outgoing"]),
    requestKind: z.string(),
    requestTitle: z.string(),
    state: z.string(),
    revision: z.number().int().positive(),
    contentTrust: z.enum(["local", "untrusted"]),
    latestDeliveryId: z.string().optional(),
  }),
]);

export const watchedSignalPayloadSchema = z.object({
  watched: z.literal(true),
  sourcePid: z.string().trim().min(1).optional(),
  watch: z.object({
    key: z.string().trim().min(1).optional(),
    state: z.json().optional(),
  }).optional(),
  payload: z.json().optional(),
}).passthrough();

export type WatchedSignalPayload = z.infer<typeof watchedSignalPayloadSchema>;

export const ipcReplyPayloadSchema = z.object({
  callId: z.string().optional(),
  targetPid: z.string().optional(),
  sourceRunId: z.string().optional(),
  createdAt: z.number().optional(),
  deadlineAt: z.number().optional(),
  nextCheckAt: z.number().optional(),
  checkInCount: z.number().int().nonnegative().optional(),
  error: nonEmptyStringSchema.optional(),
  response: z.json().optional(),
}).passthrough();

export type IpcReplyPayload = z.infer<typeof ipcReplyPayloadSchema>;

export const identityChangedPayloadSchema = z.object({
  identity: processIdentitySchema,
});

export const deliveryNoticePayloadSchema = z.object({
  message: nonEmptyStringSchema,
  noticeId: z.string().trim().regex(/^[a-zA-Z0-9._:-]{1,200}$/u),
  runId: z.string().optional(),
});

export const assistantMessageDiagnosticsSchema = z.array(z.object({
  type: z.string(),
  timestamp: z.number(),
  error: z.object({
    name: z.string().optional(),
    message: z.string(),
    stack: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
  }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}));

export const protocolStopReasonSchema = z.enum([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
]);

export const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional().catch(undefined);

export const abortedRunIdsSchema = z.array(z.string());

export const conversationProvenanceSchema = z.object({
  conversationId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
});

export const archivedToolCallSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: jsonObjectSchema,
  thoughtSignature: z.string().optional(),
});

export const archivedThinkingSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});

export const archivedMessageSchema = z.object({
  id: z.number().int().positive().optional().catch(undefined),
  run_id: optionalNonEmptyStringSchema,
  role: z.enum(["user", "assistant", "system", "toolResult"]),
  content: z.string().catch(""),
  tool_calls: z.unknown().optional(),
  thinking: z.unknown().optional(),
  tool_call_id: optionalNonEmptyStringSchema,
  media: z.optional(jsonValueSchema).catch(undefined),
  origin: z.unknown().optional(),
  metadata: z.unknown().optional(),
  ts: z.number().finite().optional().catch(undefined),
});

export const archivedToolResultMetadataSchema = z.object({
  toolName: optionalNonEmptyStringSchema,
  isError: z.boolean().optional().catch(undefined),
  outcome: z.enum(["completed", "failed", "cancelled", "denied"]).optional().catch(undefined),
});

export const archiveToolCallsSchema = z.array(archivedToolCallSchema);

export const archiveThinkingSchema = z.array(archivedThinkingSchema);

const archivedAdapterSurfaceSchema = z.object({
  kind: z.enum(["dm", "group", "channel", "thread"]),
  id: nonEmptyStringSchema,
  name: optionalNonEmptyStringSchema,
  handle: optionalNonEmptyStringSchema,
  threadId: optionalNonEmptyStringSchema,
});

const adapterMessageDestinationSchema = z.object({
  kind: z.literal("adapter"),
  adapter: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  actorId: nonEmptyStringSchema,
  surface: archivedAdapterSurfaceSchema,
});

export const interactionOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("client"),
    connectionId: nonEmptyStringSchema,
    clientId: optionalNonEmptyStringSchema,
    platform: optionalNonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal("adapter"),
    adapter: nonEmptyStringSchema,
    accountId: nonEmptyStringSchema,
    surface: archivedAdapterSurfaceSchema,
    actorId: nonEmptyStringSchema,
    actorLabel: optionalNonEmptyStringSchema,
    messageId: optionalNonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal("device"),
    deviceId: nonEmptyStringSchema,
    cwd: optionalNonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal("process"),
    sourcePid: nonEmptyStringSchema,
    uid: z.number().finite().optional().catch(undefined),
  }),
  z.object({
    kind: z.literal("scheduler"),
    scheduleId: nonEmptyStringSchema,
    replyTo: adapterMessageDestinationSchema.optional().catch(undefined),
  }),
]);

export type ReplyDestination = {
  key: string;
  description: string;
};
