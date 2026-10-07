import type { BrowserHandoff } from "@humansandmachines/gsv/protocol";
import type { CloudBrowser } from "./browser";
import { BrowserView } from "./browser-view";

/** Owns one viewer, including tab following, liveness checks, and producer subscriptions. */
export class BrowserWatch {
  readonly view: BrowserView;
  private unsubscribeState?: () => void;
  private unsubscribeFrames?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private tabId = 0;
  private state = "";
  private lastStateAt = 0;
  private refreshing = false;
  private closed = false;
  constructor(
    private readonly browser: CloudBrowser,
    private readonly selectedTab: number | undefined,
    private readonly handoff: () => BrowserHandoff | undefined,
    private readonly check: () => void,
    private readonly failure: (cause: unknown) => Error,
    onClose: () => void,
  ) {
    this.view = new BrowserView(() => {
      this.closed = true; this.generation++;
      clearInterval(this.timer);
      this.unsubscribeState?.(); this.unsubscribeFrames?.();
      onClose();
    });
  }
  async start(): Promise<void> {
    try {
      await this.browser.listTabs();
      this.check();
      this.unsubscribeState = this.browser.onViewChange(() => { void this.update().catch(cause => this.fail(cause)); });
      await this.update();
      if (this.closed) return;
      this.timer = setInterval(() => {
        this.view.checkConsumer();
        if (this.closed || this.refreshing) return;
        this.refreshing = true;
        void this.browser.listTabs().then(() => this.update()).catch(cause => this.fail(cause)).finally(() => { this.refreshing = false; });
      }, 1000);
    } catch (cause) { this.fail(cause); throw cause; }
  }
  private async update(): Promise<void> {
    if (this.closed) return;
    this.check();
    const state = { ...this.browser.viewState(), handoff: this.handoff() };
    const serialized = JSON.stringify(state);
    if (serialized !== this.state || Date.now() - this.lastStateAt >= 10000) {
      this.state = serialized; this.lastStateAt = Date.now(); this.view.state(state);
    }
    const requested = this.selectedTab ?? state.handoff?.activeTabId ?? state.handoff?.tabId ?? state.activeTabId;
    const next = state.tabs.find(tab => tab.id === requested) ?? state.tabs.find(tab => tab.id === state.activeTabId) ?? state.tabs[0];
    if (!next) throw new Error("This browser has no open tabs");
    if (this.tabId === next.id) return;
    this.tabId = next.id;
    const generation = ++this.generation;
    this.unsubscribeFrames?.(); this.unsubscribeFrames = undefined;
    this.view.invalidateFrame();
    const unsubscribe = await this.browser.watchTab(next.id, frame => {
      if (!this.closed && generation === this.generation) this.view.frame(frame);
    }, cause => { if (generation === this.generation) this.fail(cause); });
    if (this.closed || generation !== this.generation) unsubscribe();
    else this.unsubscribeFrames = unsubscribe;
  }
  private fail(cause: unknown): void { if (!this.closed) this.view.close(this.failure(cause)); }
}
