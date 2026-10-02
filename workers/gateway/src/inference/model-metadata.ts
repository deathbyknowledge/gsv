import type { InferenceExecutionService } from "@humansandmachines/gsv/services/inference-execution";
import { emitTelemetry, type TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";
import { raceWithAbort } from "../shared/abort";
import { TimeoutError } from "./timeout";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 64;
const LOOKUP_TIMEOUT_MS = 10_000;

/** One Kernel's metadata only. Never caches credentials, admission or in-flight RPCs. */
export class ModelMetadataResolver {
  private readonly cache = new Map<string, { value: number | null; expiresAt: number }>();

  constructor(
    private readonly env: TelemetryEnvironment & { INFERENCE_EXECUTION?: InferenceExecutionService },
    private readonly installationId: string,
  ) {}

  async resolve(provider: string, model: string, generationTimeoutMs: number): Promise<number | null> {
    const service = this.env.INFERENCE_EXECUTION;
    if (!service) return null;
    const startedAt = Date.now();
    const lookup = { installationId: this.installationId, lookupId: crypto.randomUUID() };
    const key = JSON.stringify([provider, model]);
    const cached = this.cache.get(key);
    const hit = cached !== undefined && cached.expiresAt > startedAt;
    let outcome: "ok" | "error" = "error";
    const timeoutMs = Math.min(generationTimeoutMs, LOOKUP_TIMEOUT_MS);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (hit) {
        outcome = "ok";
        return cached.value;
      }
      this.cache.delete(key);
      timeout = setTimeout(() => controller.abort(
        new TimeoutError(`Model metadata resolution timed out after ${timeoutMs}ms`),
      ), timeoutMs);
      const pending = service.resolveModel(provider, model, lookup);
      const metadata = await raceWithAbort(pending, controller.signal, { onAbort: () => {
        // SAFETY: Cloudflare RPC promises provide optional explicit disposal.
        const rpc = pending as typeof pending & { [Symbol.dispose]?: () => void };
        try { rpc[Symbol.dispose]?.(); } catch { /* Timeout remains terminal if disposal fails. */ }
      } });
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
      this.cache.set(key, { value: metadata.contextWindowTokens, expiresAt: startedAt + CACHE_TTL_MS });
      outcome = "ok";
      return metadata.contextWindowTokens;
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
