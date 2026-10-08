import type { TargetFileSystem } from "./types";
import type { TabList } from "./tab-metadata";
/** Values serialized across the browser backend boundary; absent object fields are omitted. */
export type BrowserValue = string | number | boolean | null | undefined | BrowserValue[] | { [key: string]: BrowserValue };
export type DebuggerCommand<Target> = <T extends object | undefined = object | undefined>(target: Target, method: string, params?: Record<string, BrowserValue>) => Promise<T>;
export type BrowserInputBackend = {
  /** Keep one complete input action together when several actors share a browser. */
  runInput?<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};
export type DebuggerBackend<Target> = BrowserInputBackend & {
  acquireDebugger(tabId: number): Promise<Target>;
  releaseDebugger(tabId: number): Promise<void>;
  sendDebuggerCommand: DebuggerCommand<Target>;
};
export type TabSummary = {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  audible: boolean;
  muted: boolean;
  status: string | null;
  title: string | null;
  url: string | null;
  favIconUrl: string | null;
};
export type BrowserPageBackend = {
  activeTab(): Promise<TabSummary | null>;
  getTab(tabId: number): Promise<TabSummary | null>;
  captureTabPng(tabId: number): Promise<Uint8Array>;
  executeInTab<Args extends BrowserValue[], T>(tabId: number, func: (...args: Args) => T, args: Args): Promise<T>;
};
export type BrowserTabsBackend = BrowserInputBackend & Pick<BrowserPageBackend, "activeTab" | "getTab"> & {
  listTabs(offset?: number): Promise<TabList>;
  createTab(url: string, active: boolean): Promise<TabSummary>;
  focusTab(tabId: number): Promise<TabSummary>;
  closeTab(tabId: number): Promise<void>;
  reloadTab(tabId: number): Promise<void>;
  viewerUrlFor(path: string, contentType: string, label: string, fs: TargetFileSystem): Promise<string> | string;
};
