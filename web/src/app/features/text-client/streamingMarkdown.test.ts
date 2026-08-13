import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MarkdownPreparationRequest,
  MarkdownWorkerResult,
} from "./markdownProtocol";
import {
  MarkdownPreparationController,
  preparedMarkdownPrefix,
  presentedMarkdownSource,
  shouldUseMainThreadMarkdownFallback,
  type PreparedMarkdown,
} from "./streamingMarkdown";

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<MarkdownWorkerResult>) => void) | null = null;
  readonly posted: MarkdownPreparationRequest[] = [];
  terminated = false;

  postMessage(message: MarkdownPreparationRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  prepared(request: MarkdownPreparationRequest, html = `<p>${request.source}</p>`): void {
    this.onmessage?.({
      data: {
        type: "prepared",
        generation: request.generation,
        blocks: [{ key: "0:paragraph", html }],
      },
    } as unknown as MessageEvent<MarkdownWorkerResult>);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MarkdownPreparationController", () => {
  it("reserves the bounded main-thread fallback for completed Worker failures", () => {
    const base = {
      cached: false,
      complete: true,
      enabled: true,
      sourceLength: 1024,
      workerUnavailable: true,
    };

    expect(shouldUseMainThreadMarkdownFallback(base)).toBe(true);
    expect(shouldUseMainThreadMarkdownFallback({ ...base, complete: false })).toBe(false);
    expect(shouldUseMainThreadMarkdownFallback({ ...base, workerUnavailable: false })).toBe(false);
    expect(shouldUseMainThreadMarkdownFallback({ ...base, cached: true })).toBe(false);
    expect(shouldUseMainThreadMarkdownFallback({ ...base, sourceLength: 64 * 1024 + 1 })).toBe(false);
  });

  it("keeps a coherent prepared snapshot across appends but rejects corrections", () => {
    const prepared: PreparedMarkdown = {
      blocks: [{ key: "0:paragraph", html: "<p>Hello</p>" }],
      generation: 1,
      presentationRevision: 1,
      source: "Hello",
    };

    expect(preparedMarkdownPrefix(prepared, "Hello world")).toBe(prepared);
    expect(preparedMarkdownPrefix(prepared, "Right world")).toBeNull();
    expect(presentedMarkdownSource(prepared, "Hello world")).toBe("Hello");
    expect(presentedMarkdownSource(prepared, "Right world")).toBe("Right world");
  });

  it("never splices an unparsed tail after an open Markdown construct", () => {
    const prepared: PreparedMarkdown = {
      blocks: [{ key: "0:code", html: "<pre><code>const answer</code></pre>" }],
      generation: 1,
      presentationRevision: 1,
      source: "```ts\nconst answer",
    };
    const latest = "```ts\nconst answer = 42;\n```";

    expect(presentedMarkdownSource(prepared, latest)).toBe(prepared.source);
    expect(presentedMarkdownSource(prepared, latest)).not.toContain(" = 42");
  });

  it("publishes a parsed prefix while retaining only the latest queued snapshot", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const prepared = vi.fn();
    const controller = new MarkdownPreparationController({
      createWorker: () => worker,
      intervalMs: 40,
      onPrepared: prepared,
    });

    controller.update("Hello");
    vi.advanceTimersByTime(40);
    const first = worker.posted[0];
    expect(first?.source).toBe("Hello");

    controller.update("Hello **w");
    controller.update("Hello **world**");
    worker.prepared(first!);
    expect(prepared).toHaveBeenLastCalledWith(expect.objectContaining({
      presentationRevision: expect.any(Number),
      source: "Hello",
    }));

    vi.advanceTimersByTime(40);
    expect(worker.posted).toHaveLength(2);
    expect(worker.posted[1]?.source).toBe("Hello **world**");
  });

  it("never publishes an obsolete prefix after an authoritative correction", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const prepared = vi.fn();
    const controller = new MarkdownPreparationController({
      createWorker: () => worker,
      intervalMs: 0,
      onPrepared: prepared,
    });

    controller.update("Wrong **answer**");
    vi.runOnlyPendingTimers();
    const wrong = worker.posted[0]!;
    controller.update("Right **answer**");
    worker.prepared(wrong);
    expect(prepared).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();
    const right = worker.posted[1]!;
    worker.prepared(right);
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ source: "Right **answer**" }));
  });

  it("rejects mismatched results and terminates its worker on disposal", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const prepared = vi.fn();
    const controller = new MarkdownPreparationController({
      createWorker: () => worker,
      intervalMs: 0,
      onPrepared: prepared,
    });

    controller.update("Current");
    vi.runOnlyPendingTimers();
    worker.onmessage?.({
      data: { type: "prepared", generation: 999, blocks: [] },
    } as unknown as MessageEvent<MarkdownWorkerResult>);
    expect(prepared).not.toHaveBeenCalled();

    controller.dispose();
    expect(worker.terminated).toBe(true);
    controller.update("Ignored");
    expect(worker.posted).toHaveLength(1);
  });

  it("does not schedule another parse when completion repeats the exact snapshot", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const prepared = vi.fn();
    const controller = new MarkdownPreparationController({
      createWorker: () => worker,
      intervalMs: 0,
      onPrepared: prepared,
    });

    controller.update("A **stable** answer");
    vi.runOnlyPendingTimers();
    worker.prepared(worker.posted[0]!);
    controller.update("A **stable** answer");
    vi.runOnlyPendingTimers();

    expect(worker.posted).toHaveLength(1);
    expect(prepared).toHaveBeenCalledOnce();
  });

  it("reports a worker failure so completed content can use the bounded fallback", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const unavailable = vi.fn();
    const controller = new MarkdownPreparationController({
      createWorker: () => worker,
      intervalMs: 0,
      onPrepared: vi.fn(),
      onUnavailable: unavailable,
    });

    controller.update("Broken");
    vi.runOnlyPendingTimers();
    worker.onmessage?.({
      data: { type: "failed", generation: worker.posted[0]!.generation },
    } as unknown as MessageEvent<MarkdownWorkerResult>);

    expect(unavailable).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);
  });
});
