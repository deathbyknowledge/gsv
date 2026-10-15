export type ActivityRow = `work:${string}` | `routine:${string}`;
export type ActivityRequest = { row?: ActivityRow; processId?: string; tab?: "ongoing" | "routines" | "history" };
export type ChatContext =
  | { kind: "activity"; request?: ActivityRequest }
  | { kind: "person"; url?: string }
  | { kind: "files" }
  | { kind: "connect" };
