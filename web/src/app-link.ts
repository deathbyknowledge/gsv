import type { ThreadContext } from "./thread-context";

export const OPEN_APP_EVENT = "gsv:open-app";

export type OpenAppEventDetail = {
  appId: string;
  route?: string;
  threadContext?: ThreadContext | null;
};
