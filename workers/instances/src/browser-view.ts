import { Buffer } from "node:buffer";
import type { CDPSession } from "@cloudflare/playwright";
import { encodeBrowserViewPacket, type BinaryBody, type BrowserViewFrame, type BrowserViewState } from "@humansandmachines/gsv/protocol";
import { within } from "./browser-operation";

export type CapturedBrowserFrame = Omit<BrowserViewFrame, "kind" | "sequence"> & { image: Uint8Array };
type ScreencastEvent = { data: string; sessionId: number; metadata: { timestamp?: number; deviceWidth: number; deviceHeight: number } };

/** One CDP producer per page; viewers do not stop one another's screencast. */
export class BrowserScreencast {
  private readonly listeners = new Set<(frame: CapturedBrowserFrame) => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private documentId = "";
  private latest: CapturedBrowserFrame | undefined;
  private closed = false;
  private readonly onFrame = (event: ScreencastEvent) => {
    if (this.closed) return;
    this.latest = { tabId: this.tabId, documentId: this.documentId,
      width: event.metadata.deviceWidth, height: event.metadata.deviceHeight,
      capturedAt: Math.round((event.metadata.timestamp ?? Date.now() / 1000) * 1000), image: new Uint8Array(Buffer.from(event.data, "base64")) };
    for (const listener of this.listeners) listener(this.latest);
    void this.cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(error => this.fail(error));
  };
  private readonly onNavigation = (event: { frame: { parentId?: string; loaderId: string } }) => {
    if (!event.frame.parentId) { this.documentId = event.frame.loaderId; this.latest = undefined; }
  };
  constructor(private readonly cdp: CDPSession, private readonly tabId: number) {}

  async start(): Promise<void> {
    this.cdp.on("Page.screencastFrame", this.onFrame);
    this.cdp.on("Page.frameNavigated", this.onNavigation);
    await within(this.cdp.send("Page.enable"), 5000, "Browser view connection");
    this.documentId = (await within(this.cdp.send("Page.getFrameTree"), 5000, "Browser view document")).frameTree.frame.loaderId;
    await within(this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 }), 5000, "Browser view start");
  }
  subscribe(frame: (value: CapturedBrowserFrame) => void, error: (cause: Error) => void): () => void {
    this.listeners.add(frame); this.errors.add(error);
    if (this.latest) frame(this.latest);
    return () => { this.listeners.delete(frame); this.errors.delete(error); };
  }
  get viewers(): number { return this.listeners.size; }
  private fail(error: Error): void { for (const listener of this.errors) listener(error); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cdp.off("Page.screencastFrame", this.onFrame);
    this.cdp.off("Page.frameNavigated", this.onNavigation);
    this.latest = undefined;
    await within(this.cdp.send("Page.stopScreencast"), 3000, "Browser view stop").catch(() => {});
    await this.cdp.detach().catch(() => {});
  }
}

/** Retains only the newest image while the transport waits for consumer credit. */
export class BrowserView {
  readonly body: BinaryBody;
  private controller!: ReadableByteStreamController;
  private pendingFrame: CapturedBrowserFrame | undefined;
  private pendingState: BrowserViewState | undefined;
  private sequence = 0;
  private lastReadAt = Date.now();
  private pulling = false;
  private ended = false;
  constructor(private readonly onClose: () => void) {
    const source: UnderlyingByteSource = {
      type: "bytes",
      start: controller => { this.controller = controller; },
      pull: () => { this.pulling = true; this.flush(); },
      cancel: () => { this.close(); },
    };
    this.body = { delivery: "realtime", stream: new ReadableStream(source, { highWaterMark: 0 }) };
  }
  frame(frame: CapturedBrowserFrame): void { if (!this.ended) { this.pendingFrame = frame; this.flush(); } }
  state(state: BrowserViewState): void { if (!this.ended) { this.pendingState = state; this.flush(); } }
  invalidateFrame(): void { this.pendingFrame = undefined; }
  checkConsumer(): void {
    if ((this.pendingFrame || this.pendingState) && !this.pulling && Date.now() - this.lastReadAt > 15000) this.close(new Error("Browser viewer stopped reading updates"));
  }
  close(error?: Error): void {
    if (this.ended) return;
    this.ended = true; this.pendingFrame = undefined; this.pendingState = undefined;
    if (error) this.controller.error(error);
    else { try { this.controller.close(); } catch { /* A cancelled reader is already closed. */ } }
    this.onClose();
  }
  private flush(): void {
    if (this.ended || !this.pulling) return;
    this.lastReadAt = Date.now();
    if (this.pendingState) {
      const state = this.pendingState; this.pendingState = undefined; this.pulling = false;
      this.controller.enqueue(encodeBrowserViewPacket(state));
    } else if (this.pendingFrame) {
      const frame = this.pendingFrame; this.pendingFrame = undefined; this.pulling = false;
      const { image, ...metadata } = frame;
      this.controller.enqueue(encodeBrowserViewPacket({ ...metadata, kind: "frame", sequence: ++this.sequence }, image));
    }
  }
}
