import type { InferenceExecutionService } from "@humansandmachines/gsv/services/inference-execution";
import { emitTelemetry, type TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";
import { raceWithAbort } from "../shared/abort";
import { TimeoutError } from "./timeout";

/** How long a model's context window stands; it changes only when a deploy changes the model or the deployment's default. */
const KNOWN_TTL_MS = 60 * 60_000;
/** How long runs take the last known value, or unknown, after a lookup fails, before one asks again. */
const FAILED_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 256;
const LOOKUP_TIMEOUT_MS = 10_000;

type CachedContextWindow = { value: number | null; refreshAt: number };

/** Each isolate's answers, per execution binding: a model's context window is the same for every Kernel. */
const contextWindows = new WeakMap<InferenceExecutionService, Map<string, CachedContextWindow>>();

/**
 * One Kernel's metadata only. Never caches credentials, admission or in-flight RPCs.
 * The context window only paces compaction, so a failed or slow lookup answers with
 * the last known value, however old, or unknown, and never fails the run.
 */
export class ModelMetadataResolver {
  constructor(
    private readonly env: TelemetryEnvironment & { INFERENCE_EXECUTION?: InferenceExecutionService },
    private readonly installationId: string,
  ) {}

  async resolve(provider: string, model: string, generationTimeoutMs: number): Promise<number | null> {
    const service = this.env.INFERENCE_EXECUTION;
    if (!service) return null;
    let cache = contextWindows.get(service);
    if (!cache) {
      cache = new Map();
      contextWindows.set(service, cache);
    }
    const startedAt = Date.now();
    const lookup = { installationId: this.installationId, lookupId: crypto.randomUUID() };
    const key = JSON.stringify([provider, model]);
    const cached = cache.get(key);
    const hit = cached !== undefined && cached.refreshAt > startedAt;
    let outcome: "ok" | "error" = "error";
    const timeoutMs = Math.min(generationTimeoutMs, LOOKUP_TIMEOUT_MS);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (hit) {
        outcome = "ok";
        return cached.value;
      }
      timeout = setTimeout(() => controller.abort(
        new TimeoutError(`Model metadata resolution timed out after ${timeoutMs}ms`),
      ), timeoutMs);
      const pending = service.resolveModel(provider, model, lookup);
      const metadata = await raceWithAbort(pending, controller.signal, { onAbort: () => {
        // SAFETY: Cloudflare RPC promises provide optional explicit disposal.
        const rpc = pending as typeof pending & { [Symbol.dispose]?: () => void };
        try { rpc[Symbol.dispose]?.(); } catch { /* Timeout remains terminal if disposal fails. */ }
      } });
      remember(cache, key, { value: metadata.contextWindowTokens, refreshAt: startedAt + KNOWN_TTL_MS });
      outcome = "ok";
      return metadata.contextWindowTokens;
    } catch (error) {
      // Classification only: service errors can carry private detail. The lookup
      // id joins this line to its telemetry record.
      console.warn(`[AI] Model metadata lookup ${lookup.lookupId} failed: ${error instanceof Error ? error.name : "Error"}`);
      const value = cached?.value ?? null;
      remember(cache, key, { value, refreshAt: Date.now() + FAILED_TTL_MS });
      return value;
    } finally {
      clearTimeout(timeout);
      emitTelemetry(this.env, {
        installationId: this.installationId,
        component: "gateway",
        event: {
          stream: "operational", name: "inference.metadata.finished",
          properties: {
            lookupId: lookup.lookupId, outcome: controller.signal.aborted ? "timeout" : outcome,
            durationMs: Math.max(0, Date.now() - startedAt), cache: hit ? "hit" : "miss",
          },
        },
      });
    }
  }
}

function remember(cache: Map<string, CachedContextWindow>, key: string, entry: CachedContextWindow): void {
  cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, entry);
}
