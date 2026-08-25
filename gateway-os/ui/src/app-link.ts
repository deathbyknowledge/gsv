import type { ThreadContext } from "./thread-context";

export const OPEN_APP_EVENT = "gsv:open-app";
export const APP_WINDOW_ACTION_EVENT = "gsv:window-action";

export type OpenAppEventDetail = {
  appId: string;
  threadContext?: ThreadContext | null;
};

export type AppWindowAction = "focus" | "close" | "minimize" | "maximize" | "restart";

export type AppWindowActionEventDetail = {
  windowId: string;
  action: AppWindowAction;
};
