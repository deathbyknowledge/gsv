import { acquire, type BrowserWorker } from "@cloudflare/playwright";
import { z } from "zod";

/** Use the documented fetch transport, which is also implemented by local Chromium. */
export class BrowserProvider {
  private readonly binding: BrowserWorker;
  constructor(binding: BrowserWorker) {
    this.binding = { fetch: (input, init) => binding.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }) };
  }
  async acquire(): Promise<string> {
    return (await acquire(this.binding, { keep_alive: 60_000, recording: false })).sessionId;
  }
  async exists(id: string): Promise<boolean> {
    const response = await this.binding.fetch(`http://browser-binding.invalid/v1/devtools/session/${encodeURIComponent(id)}`);
    if (response.status === 204 || response.status === 404 || response.status === 410) { await response.body?.cancel(); return false; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Browser session lookup failed (${response.status})`); }
    const session = z.object({ sessionId: z.string(), endTime: z.number().optional() }).parse(await response.json());
    if (session.sessionId !== id) throw new Error("Browser provider returned another session identity");
    return !session.endTime;
  }
  async close(id: string): Promise<void> {
    const response = await this.binding.fetch(`http://browser-binding.invalid/v1/devtools/browser/${encodeURIComponent(id)}`, { method: "DELETE" });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(`Browser shutdown could not be confirmed (${response.status})`);
  }
}
