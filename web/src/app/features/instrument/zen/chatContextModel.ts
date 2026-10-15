export type ActivityRow = `work:${string}` | `routine:${string}`;
export type ActivityRequest = { row?: ActivityRow; processId?: string; tab?: "current" | "routines" | "standing" };
export type ChatContext =
  | { kind: "activity"; request?: ActivityRequest }
  | { kind: "person"; url?: string }
  | { kind: "files"; file?: { target: string; path: string } }
  | { kind: "connect" };
