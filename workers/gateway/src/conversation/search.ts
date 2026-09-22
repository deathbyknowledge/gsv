import type {
  ConversationMessage, ConversationSearchCoverage, ConversationSearchResult,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";

const MAX_INDEXED_MESSAGES = 100_000;
const MAX_INDEXED_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_CHARACTERS = 16_384;

type SearchState = {
  backfill_before: number;
  indexed_messages: number;
  indexed_bytes: number;
  truncated_messages: number;
  omitted_messages: number;
  capacity_reached: number;
  backfill_failed: number;
};

export class ConversationSearchStore {
  constructor(private readonly sql: SqlStorage) {}

  state(): SearchState {
    return this.sql.exec<SearchState>("SELECT * FROM message_search_state WHERE id = 1").one();
  }

  index(message: Pick<ConversationMessage, "id" | "sequence" | "text" | "createdAt">): void {
    if (this.sql.exec("SELECT rowid FROM message_search WHERE rowid = ?", message.sequence).toArray().length) return;
    const state = this.state();
    const text = message.text.slice(0, MAX_MESSAGE_CHARACTERS);
    const bytes = new TextEncoder().encode(text).byteLength;
    if (state.capacity_reached || state.indexed_messages >= MAX_INDEXED_MESSAGES || state.indexed_bytes + bytes > MAX_INDEXED_BYTES) {
      this.sql.exec("UPDATE message_search_state SET capacity_reached = 1, omitted_messages = omitted_messages + 1 WHERE id = 1");
      return;
    }
    this.sql.exec("INSERT INTO message_search (rowid, message_id, text, created_at) VALUES (?, ?, ?, ?)", message.sequence, message.id, text, message.createdAt);
    this.sql.exec(`UPDATE message_search_state SET indexed_messages = indexed_messages + 1,
      indexed_bytes = indexed_bytes + ?, truncated_messages = truncated_messages + ? WHERE id = 1`, bytes, text.length < message.text.length ? 1 : 0);
  }

  finishBatch(beforeSequence: number): void {
    this.sql.exec("UPDATE message_search_state SET backfill_before = MIN(backfill_before, ?), backfill_failed = 0 WHERE id = 1", beforeSequence);
  }

  failBackfill(): void {
    this.sql.exec("UPDATE message_search_state SET backfill_failed = 1 WHERE id = 1");
  }

  needsBackfill(): boolean {
    const state = this.state();
    return state.backfill_before > 1 && !state.capacity_reached;
  }

  coverage(latestSequence: number): ConversationSearchCoverage {
    const state = this.state();
    return {
      state: state.capacity_reached ? "limited" : state.backfill_failed ? "error"
        : state.backfill_before > 1 ? "building" : state.truncated_messages ? "limited" : "complete",
      indexedMessages: state.indexed_messages,
      truncatedMessages: state.truncated_messages,
      omittedMessages: state.omitted_messages,
      historicalBeforeSequence: state.backfill_before,
      latestSequence,
    };
  }

  search(query: string, beforeSequence: number, limit: number): Pick<ConversationSearchResult, "matches" | "nextBeforeSequence"> {
    const rows = this.sql.exec<{ message_id: string; sequence: number; excerpt: string; created_at: number }>(
      `SELECT message_id, rowid AS sequence, snippet(message_search, 1, '', '', '…', 24) AS excerpt, created_at
       FROM message_search WHERE message_search MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
      literalSearchQuery(query), beforeSequence, limit + 1,
    ).toArray();
    const matches = rows.slice(0, limit).map((row) => ({
      messageId: row.message_id, sequence: row.sequence, excerpt: row.excerpt.slice(0, 600), createdAt: row.created_at,
    }));
    return { matches, ...(rows.length > limit ? { nextBeforeSequence: matches[matches.length - 1].sequence } : undefined) };
  }
}

function literalSearchQuery(query: string): string {
  z.string().check(z.minLength(1), z.maxLength(512)).parse(query);
  if (!/[\p{L}\p{N}]/u.test(query)) throw new Error("Search requires a word or number");
  const words = query.trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length > 16) throw new Error("Search supports up to 16 terms");
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" AND ");
}
