import DOMPurify from "dompurify";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  MarkdownBlock,
  MarkdownPreparationRequest,
  MarkdownWorkerResult,
} from "./markdownProtocol";

const PREPARATION_INTERVAL_MS = 40;
const SANITIZED_BLOCK_CACHE_LIMIT = 512;
const SANITIZED_BLOCK_CACHE_BYTES = 2 * 1024 * 1024;
const sanitizedBlockCache = new Map<string, string>();
let sanitizedBlockCacheBytes = 0;
const MARKDOWN_ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];
const preparedMarkdownCache = new Map<string, PreparedMarkdown>();
const PREPARED_MARKDOWN_CACHE_LIMIT = 32;
const PREPARED_MARKDOWN_CACHE_BYTES = 2 * 1024 * 1024;
const MAIN_THREAD_FALLBACK_LIMIT = 64 * 1024;
let preparedMarkdownCacheBytes = 0;
let nextPresentationRevision = 1;

type WorkerPort = Pick<Worker, "postMessage" | "terminate"> & {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<MarkdownWorkerResult>) => void) | null;
};

type PendingPreparation = {
  generation: number;
  source: string;
};

export type PreparedMarkdown = {
  generation: number;
  presentationRevision: number;
  source: string;
  blocks: readonly MarkdownBlock[];
};

type MarkdownPreparationControllerOptions = {
  createWorker: () => WorkerPort;
  onUnavailable?: () => void;
  onPrepared: (prepared: PreparedMarkdown) => void;
  intervalMs?: number;
};

/**
 * Bound one streamed document to one parse in flight and one replaceable
 * latest snapshot. Provider partials are authoritative snapshots, not an
 * append-only protocol, so older results are never published over newer text.
 */
export class MarkdownPreparationController {
  private active: PendingPreparation | null = null;
  private current: PendingPreparation | null = null;
  private disposed = false;
  private generation = 0;
  private pending: PendingPreparation | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;
  private readonly onPrepared: (prepared: PreparedMarkdown) => void;
  private readonly onUnavailable: () => void;
  private readonly worker: WorkerPort;

  constructor(options: MarkdownPreparationControllerOptions) {
    this.intervalMs = options.intervalMs ?? PREPARATION_INTERVAL_MS;
    this.onPrepared = options.onPrepared;
    this.onUnavailable = options.onUnavailable ?? (() => undefined);
    this.worker = options.createWorker();
    this.worker.onmessage = (event) => this.accept(event.data);
    this.worker.onerror = () => this.disable();
  }

  update(source: string): void {
    if (this.disposed || this.current?.source === source) return;
    const next = { generation: ++this.generation, source };
    this.current = next;
    this.pending = next;
    if (!this.active) this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.active = null;
    this.worker.terminate();
  }

  private schedule(): void {
    if (this.disposed || this.timer || this.active || !this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.active || !this.pending) return;
      const request = this.pending;
      this.pending = null;
      this.active = request;
      const message: MarkdownPreparationRequest = { type: "prepare", ...request };
      try {
        this.worker.postMessage(message);
      } catch {
        this.disable();
      }
    }, this.intervalMs);
  }

  private accept(result: MarkdownWorkerResult): void {
    if (this.disposed || !this.active) return;
    const active = this.active;
    const matchesActive = result.generation === active.generation;
    if (!matchesActive) return;
    this.active = null;
    if (
      result.type === "prepared"
      && this.current?.source.startsWith(active.source)
    ) {
      this.onPrepared({
        ...result,
        presentationRevision: nextPresentationRevision++,
        source: active.source,
      });
    } else if (result.type === "failed") {
      this.disable();
      return;
    }
    if (this.pending) this.schedule();
  }

  private disable(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.active = null;
    this.worker.terminate();
    this.onUnavailable();
  }
}

function createMarkdownWorker(): WorkerPort {
  return new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
}

function rememberPrepared(prepared: PreparedMarkdown): void {
  const size = prepared.source.length + prepared.blocks.reduce(
    (total, block) => total + block.key.length + block.html.length,
    0,
  );
  const replaced = preparedMarkdownCache.get(prepared.source);
  if (replaced) {
    preparedMarkdownCacheBytes -= replaced.source.length + replaced.blocks.reduce(
      (total, block) => total + block.key.length + block.html.length,
      0,
    );
    preparedMarkdownCache.delete(prepared.source);
  }
  while (
    preparedMarkdownCache.size >= PREPARED_MARKDOWN_CACHE_LIMIT
    || preparedMarkdownCacheBytes + size > PREPARED_MARKDOWN_CACHE_BYTES
  ) {
    const oldest = preparedMarkdownCache.keys().next().value;
    if (oldest === undefined) break;
    const removed = preparedMarkdownCache.get(oldest);
    if (removed) {
      preparedMarkdownCacheBytes -= removed.source.length + removed.blocks.reduce(
        (total, block) => total + block.key.length + block.html.length,
        0,
      );
    }
    preparedMarkdownCache.delete(oldest);
  }
  if (size <= PREPARED_MARKDOWN_CACHE_BYTES) {
    preparedMarkdownCache.set(prepared.source, prepared);
    preparedMarkdownCacheBytes += size;
  }
}

export function usePreparedMarkdown(
  source: string,
  enabled = true,
  complete = false,
): PreparedMarkdown | null {
  const [prepared, setPrepared] = useState<PreparedMarkdown | null>(() => (
    enabled ? preparedMarkdownCache.get(source) ?? null : null
  ));
  const latestSource = useRef(source);
  const controller = useRef<MarkdownPreparationController | null>(null);
  const [workerUnavailable, setWorkerUnavailable] = useState(false);
  latestSource.current = source;

  useEffect(() => {
    if (!enabled) {
      setPrepared(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (typeof Worker === "undefined") {
      setWorkerUnavailable(true);
      return;
    }
    try {
      controller.current = new MarkdownPreparationController({
        createWorker: createMarkdownWorker,
        onUnavailable: () => setWorkerUnavailable(true),
        onPrepared: (next) => {
          rememberPrepared(next);
          setPrepared(next);
        },
      });
      if (!preparedMarkdownCache.has(latestSource.current)) {
        controller.current.update(latestSource.current);
      }
    } catch {
      controller.current = null;
      setWorkerUnavailable(true);
    }
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const cached = preparedMarkdownCache.get(source);
    if (cached) {
      setPrepared(cached);
    } else {
      controller.current?.update(source);
    }
  }, [enabled, source]);

  useEffect(() => {
    // Normal completion never enters this path. This is only a bounded recovery
    // for browsers where the Worker could not be constructed or stopped.
    if (!shouldUseMainThreadMarkdownFallback({
      cached: preparedMarkdownCache.has(source),
      complete,
      enabled,
      sourceLength: source.length,
      workerUnavailable,
    })) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void import("./markdownParser").then(({ prepareMarkdownBlocks }) => {
        if (cancelled) return;
        const next = {
          generation: 0,
          presentationRevision: nextPresentationRevision++,
          source,
          blocks: prepareMarkdownBlocks(source),
        };
        rememberPrepared(next);
        setPrepared(next);
      }).catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [complete, enabled, source, workerUnavailable]);

  return prepared;
}

export function shouldUseMainThreadMarkdownFallback({
  cached,
  complete,
  enabled,
  sourceLength,
  workerUnavailable,
}: {
  cached: boolean;
  complete: boolean;
  enabled: boolean;
  sourceLength: number;
  workerUnavailable: boolean;
}): boolean {
  return enabled
    && complete
    && workerUnavailable
    && !cached
    && sourceLength <= MAIN_THREAD_FALLBACK_LIMIT;
}

function sanitizeBlock(html: string): string {
  const cacheKey = html;
  const cached = sanitizedBlockCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const sanitized = typeof DOMPurify.sanitize === "function" ? String(DOMPurify.sanitize(html, {
    ALLOWED_ATTR: ["alt", "href", "src", "title"],
    ALLOWED_TAGS: [...MARKDOWN_ALLOWED_TAGS, "img"],
    ALLOW_DATA_ATTR: false,
  })) : "";
  while (
    sanitizedBlockCache.size >= SANITIZED_BLOCK_CACHE_LIMIT
    || sanitizedBlockCacheBytes + cacheKey.length + sanitized.length > SANITIZED_BLOCK_CACHE_BYTES
  ) {
    const oldest = sanitizedBlockCache.keys().next().value;
    if (oldest === undefined) break;
    const removed = sanitizedBlockCache.get(oldest) ?? "";
    sanitizedBlockCacheBytes -= oldest.length + removed.length;
    sanitizedBlockCache.delete(oldest);
  }
  if (cacheKey.length + sanitized.length <= SANITIZED_BLOCK_CACHE_BYTES) {
    sanitizedBlockCache.set(cacheKey, sanitized);
    sanitizedBlockCacheBytes += cacheKey.length + sanitized.length;
  }
  return sanitized;
}

export function StreamingMarkdown({
  prepared,
  source,
}: {
  prepared: PreparedMarkdown | null;
  source: string;
}): JSX.Element {
  const usable = preparedMarkdownPrefix(prepared, source);
  const blocks = useMemo(() => usable?.blocks.map((block) => ({
    ...block,
    html: sanitizeBlock(block.html),
  })) ?? [], [usable]);

  if (!usable) return <>{source}</>;
  return (
    <div class="text-client-rich">
      {blocks.map((block) => (
        <div
          class="text-client-rich-block"
          dangerouslySetInnerHTML={{ __html: block.html }}
          key={block.key}
        />
      ))}
    </div>
  );
}

export function preparedMarkdownPrefix(
  prepared: PreparedMarkdown | null,
  source: string,
): PreparedMarkdown | null {
  return prepared && source.startsWith(prepared.source) ? prepared : null;
}

/** The exact source currently represented by the DOM; no unparsed tail is spliced into it. */
export function presentedMarkdownSource(
  prepared: PreparedMarkdown | null,
  source: string,
): string {
  return preparedMarkdownPrefix(prepared, source)?.source ?? source;
}
