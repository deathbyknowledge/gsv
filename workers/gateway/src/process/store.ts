/**
 * ProcessStore — SQLite-backed state for a single Process DO.
 *
 * Manages:
 *   - messages: the process history (agent loop working memory)
 *   - pending_tool_calls: in-flight tool calls awaiting results
 *   - message_queue: FIFO queue for messages arriving during an active run
 *   - process_kv: key-value metadata (processId, archiveId, etc.)
 */

import { ProcessStateRepository } from "./storage/state-repository";
import { ProcessTraceRepository } from "./storage/trace-repository";
import { ProcessContextEpochRepository } from "./storage/context-epoch-repository";
import { ProcessHistoryRepository } from "./storage/history-repository";
import { ProcessToolRepository } from "./storage/tool-repository";
import { ProcessMessageRepository } from "./storage/message-repository";
import { ProcessQueueRepository } from "./storage/queue-repository";

export * from "./storage/store-codecs";

/** Composes repositories and owns multi-repository SQLite transitions. */
export class ProcessStore {
  readonly state = new ProcessStateRepository(this);
  readonly traces = new ProcessTraceRepository(this);
  readonly epochs = new ProcessContextEpochRepository(this);
  readonly history = new ProcessHistoryRepository(this);
  readonly tools = new ProcessToolRepository(this);
  readonly messages = new ProcessMessageRepository(this);
  readonly queue = new ProcessQueueRepository(this);

  constructor(readonly sql: SqlStorage) {}

  first<Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): Row | undefined {
    return this.sql.exec<Row>(query, ...bindings).toArray()[0];
  }

  resetHistory(): number {
    const generation = this.state.getHistoryGeneration() + 1;
    this.messages.clearMessages();
    this.traces.clearTraceSpans();
    this.state.setValue("historyGeneration", String(generation));
    return generation;
  }
}
