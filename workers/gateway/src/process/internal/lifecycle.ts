/** Internal Process lifecycle primitives. */

import {
  type InteractionOrigin, type JsonValue, type ProcKillResult, type ProcToolResultOutcome, type ResourceBlock,
  resourceBlockSchema,
} from "@humansandmachines/gsv/protocol";
import type { MessageMetadata, MessageRole } from "../store";
import type { ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export const PROCESS_KILLED_TOMBSTONE_KEY = "__gsv_process_killed__";

export type ProcessKilledTombstone = {
  version: 1;
  pid: string;
  uid: number | null;
  result: Extract<ProcKillResult, { ok: true; }>;
  cleanup: "pending" | "completed";
  pendingCleanup: Array<"alarm" | "media">;
};

export function tombstoneKilledProcessStorage(
  storage: DurableObjectStorage,
  tombstone: ProcessKilledTombstone,
): void {
  storage.transactionSync(() => {
    const tableNames = storage.sql.exec<{ name: string; }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND substr(lower(name), 1, 4) != '_cf_'
         AND substr(lower(name), 1, 5) != '__cf_'
       ORDER BY name`,
    ).toArray().map((row) => row.name);
    const kvKeys = [...storage.kv.list()].map(([key]) => key);

    for (const tableName of tableNames) {
      const quotedName = `"${tableName.replaceAll('"', '""')}"`;
      storage.sql.exec(`DROP TABLE IF EXISTS ${quotedName}`);
    }
    for (const key of kvKeys) {
      storage.kv.delete(key);
    }
    storage.kv.put(PROCESS_KILLED_TOMBSTONE_KEY, tombstone);
  });
}

export type ArchivedMessageRecord = {
  id?: number;
  runId?: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  thinking?: ThinkingContent[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  outcome?: ProcToolResultOutcome;
  media?: JsonValue;
  origin?: InteractionOrigin;
  metadata?: MessageMetadata;
  createdAt?: number;
};

export type ArchivedMediaRewrite =
  | { key: string; path: string; revision: string; }
  | { missing: true; };

export type RuntimeEventAdmission =
  | { ok: true; runId: string; queued: boolean; }
  | { ok: false; error: string; };

export const TOOL_APPROVAL_OVERRIDES_KEY = "toolApprovalOverrides";

export const MAX_KILL_ARCHIVE_ATTEMPTS = 3;

export const HANDLED_IPC_CALLS_KEY = "handledIpcCalls";

export const ABORTED_RUN_IDS_KEY = "abortedRunIds";

export const DELIVERY_NOTICE_IDS_KEY = "deliveryNoticeIds";

export const RUNTIME_EVENT_IDS_KEY = "runtimeEventIds";

export const PROCESS_RESET_AT_KEY = "processResetAt";

export const IPC_TOMBSTONE_LIMIT = 256;

export const DELIVERY_NOTICE_TOMBSTONE_LIMIT = 256;

export const RUNTIME_EVENT_TOMBSTONE_LIMIT = 512;

export const SHELL_SESSION_TARGET_KEY_PREFIX = "shellSessionTarget:";

export const UNKNOWN_SHELL_SESSION_TARGET_MESSAGE =
  "Shell session continuation requires an explicit target because this process does not know which device owns the session";

export const USER_INTERRUPTED_TOOL_MESSAGE = "User interrupted tool execution";

export const MAX_TERMINAL_CORRECTION_ROUNDS = 1;

export const MAX_TERMINAL_COMMAND_FAILURES = 5;

export const MAX_TERMINAL_DELIVERY_FAILURES = 3;

export const FINAL_MESSAGE_BLOCK_EXAMPLE =
  "message send <<'GSV_MESSAGE' && yield\nyour user-visible response\nGSV_MESSAGE";

export const RUN_CONTROL_INSTRUCTION =
  `Use a direct \`message send\` Shell call whenever the user should receive a message; sending does not finish the run. After all work is complete, run \`yield\`, or compose the final message as:\n${FINAL_MESSAGE_BLOCK_EXAMPLE}\nOrdinary assistant text is Process activity and is not sent to the user.`;

export const PENDING_RUN_CONTROL_CALL = "Shell";

export const INTERRUPTED_RUN_CONTROL_MESSAGE =
  "Run-control completion was interrupted before its result was recorded; its external effect may already have completed";

export const USER_SUPERSEDED_TOOL_MESSAGE =
  "Cancelled for this agent run because a newer user message arrived; the underlying operation may still complete";

export const TOOL_EXECUTION_DENIED_BY_USER_MESSAGE = "Tool execution denied by user";

export const RUNTIME_EVENT_WAKE_MESSAGE =
  "A runtime event arrived while you were busy. Review the GSV event above and continue.";

export const MAX_PROCESS_MEDIA_READ_BYTES = 25 * 1024 * 1024;

export type ResourceRetentionOptions = {
  runId?: string;
  signal?: AbortSignal;
  current: () => boolean;
  targetKey?: string;
  mediaAdmissionHeld?: boolean;
};

export type ResourceRetentionResult = {
  resource: ResourceBlock;
  createdKey?: string;
};

export function retainedResourceBlock(
  resource: ResourceBlock,
  path: string,
  revision: string,
): ResourceBlock {
  return resourceBlockSchema.parse({
    ...resource,
    ref: {
      type: "file",
      target: "gsv",
      path,
      revision,
      contentType: resource.ref.contentType,
      size: resource.ref.size,
    },
  });
}

export const CODE_MODE_NESTED_SYSCALL_TIMEOUT_MS = 55_000;

export const CODE_MODE_APPROVAL_TIMEOUT_MS = 55_000;

export const TOOL_DISPATCH_TIMEOUT_MS = 10 * 60_000;

export const MEDIA_PREPARATION_TIMEOUT_MS = 10 * 60_000;

export const COMPACTION_SUMMARY_WINDOW_CHARS = 24_000;

export const COMPACTION_SUMMARY_MAX_TOKENS = 768;

export const CONTEXT_PROVIDER_OVERFLOW_REASON = "context.provider_overflow";

export const CONTEXT_RUNWAY_ALERT_EPOCH_KEY = "contextRunwayAlertEpoch";

export const CONTEXT_RUNWAY_ALERT_MAX_TOKENS_BEFORE_BOUNDARY = 64_000;

export const CONTEXT_RUNWAY_ALERT_BUDGET_RATIO_BEFORE_BOUNDARY = 0.2;

export const MAX_RETRYABLE_GENERATION_ATTEMPTS = 3;

export const MAX_CANCELLED_REQUESTS = 128;
