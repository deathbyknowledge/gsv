import type { ProcessStore } from "../store";
import { INITIAL_HISTORY_GENERATION } from "../history";
import { PROCESS_AI_CONFIG_STORE_KEY, parseProcessAiConfigSnapshot } from "../ai-config";
import type { ProcAiConfigSnapshot, ProcContextState, ProcUsageState } from "@humansandmachines/gsv/protocol";
import { emptyUsageState, mergeUsageStates, normalizeContextState, normalizeUsageState } from "./store-codecs";

/** Owns opaque Process values, configuration snapshots, and usage counters. */
export class ProcessStateRepository {
  constructor(private readonly store: ProcessStore) { }

  private parseValue<T>(key: string, parse: (raw: string) => T | null): T | null {
    const raw = this.getValue(key);
    if (!raw) return null;
    try {
      return parse(raw);
    } catch {
      return null;
    }
  }

  // --- History ---

  getHistoryGeneration(): number {
    const stored = Number.parseInt(this.getValue("historyGeneration") ?? "", 10);
    return Number.isSafeInteger(stored) && stored > 0
      ? stored
      : INITIAL_HISTORY_GENERATION;
  }

  // we could use `this.ctx.storage.kv` but the sqlite tables
  // it generates are private and can't see it, so we implement
  // it ourselves so we can inspect the tables.

  getValue(key: string): string | null {
    return this.store.first<{ value: string }>(
      "SELECT value FROM process_kv WHERE key = ?", key,
    )?.value ?? null;
  }

  setValue(key: string, value: string): void {
    this.store.sql.exec(
      "INSERT OR REPLACE INTO process_kv (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  deleteValue(key: string): void {
    this.store.sql.exec("DELETE FROM process_kv WHERE key = ?", key);
  }

  getAiConfigSnapshot(): ProcAiConfigSnapshot | null {
    return this.parseValue(PROCESS_AI_CONFIG_STORE_KEY, parseProcessAiConfigSnapshot);
  }

  setAiConfigSnapshot(snapshot: ProcAiConfigSnapshot): void {
    this.setValue(PROCESS_AI_CONFIG_STORE_KEY, JSON.stringify(snapshot));
  }

  clearAiConfigSnapshot(): void {
    this.deleteValue(PROCESS_AI_CONFIG_STORE_KEY);
  }

  getContextState(): ProcContextState | null {
    return this.parseValue("contextState", (raw) => normalizeContextState(JSON.parse(raw)));
  }

  setContextState(state: ProcContextState): void {
    this.setValue("contextState", JSON.stringify(state));
  }

  getContextStateRevision(): number {
    const stored = Number.parseInt(this.getValue("contextStateRevision") ?? "", 10);
    return Math.max(
      Number.isSafeInteger(stored) && stored >= 0 ? stored : 0,
      this.getContextState()?.revision ?? 0,
    );
  }

  nextContextStateRevision(): number {
    const current = this.getContextStateRevision();
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Context state revision exhausted");
    }
    const revision = current + 1;
    this.setValue("contextStateRevision", String(revision));
    return revision;
  }

  deleteContextState(): void {
    this.deleteValue("contextState");
  }

  getHistoryUsage(): ProcUsageState | null {
    return this.parseValue("historyUsage", (raw) => normalizeUsageState(JSON.parse(raw)));
  }

  addHistoryUsage(usage: ProcUsageState): ProcUsageState {
    const normalizedUsage = normalizeUsageState(usage);
    if (!normalizedUsage) {
      return this.getHistoryUsage() ?? emptyUsageState();
    }
    const merged = mergeUsageStates(
      this.getHistoryUsage(),
      normalizedUsage,
    );
    this.setValue("historyUsage", JSON.stringify(merged));
    return merged;
  }

  deleteHistoryUsage(): void {
    this.deleteValue("historyUsage");
  }
}
