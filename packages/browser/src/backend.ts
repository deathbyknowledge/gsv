import type { TargetFileSystem } from "./types";
export type BrowserValue = string | number | boolean | null | undefined | BrowserValue[] | object;
export type DebuggerCommand<Target> = <T extends object | undefined = object | undefined>(target: Target, method: string, params?: Record<string, BrowserValue>) => Promise<T>;
export type DebuggerBackend<Target> = {
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
  executeInTab<T>(tabId: number, func: (...args: BrowserValue[]) => T, args?: BrowserValue[]): Promise<T>;
};
export type BrowserTabsBackend = Pick<BrowserPageBackend, "activeTab" | "getTab"> & {
  listTabs(): Promise<TabSummary[]>;
  createTab(url: string, active: boolean): Promise<TabSummary>;
  focusTab(tabId: number): Promise<TabSummary>;
  closeTab(tabId: number): Promise<void>;
  reloadTab(tabId: number): Promise<void>;
  viewerUrlFor(path: string, contentType: string, label: string, fs: TargetFileSystem): Promise<string> | string;
};
