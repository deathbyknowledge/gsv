import type { ConversationAction } from "@humansandmachines/gsv/protocol";

export type ActivityRow = `work:${string}` | `routine:${string}`;
export type ActivityRequest = { row?: ActivityRow; processId?: string; tab?: "current" | "routines" | "standing" };
export type ChatContext =
  | { kind: "activity"; request?: ActivityRequest }
  | { kind: "person"; url?: string }
  | { kind: "files"; file?: { target: string; path: string } }
  | { kind: "connect" };

export function actionTitle(action: ConversationAction): string {
  switch (action.kind) {
    case "routine.create": return "Create a routine";
    case "machine.connect": return "Connect a computer";
    case "browser.start": return "Start a browser";
    case "routine.discuss": return action.name;
    case "responsibility.discuss": return action.name;
    case "profile.discuss": return action.name;
    case "file.discuss": return action.path.split("/").filter(Boolean).at(-1) ?? action.path;
  }
}

export function actionSubtitle(action: ConversationAction): string {
  switch (action.kind) {
    case "routine.create": return "routine";
    case "machine.connect": return "computer";
    case "browser.start": return "browser";
    case "routine.discuss": return "routine";
    case "responsibility.discuss": return "responsibility";
    case "profile.discuss": return new URL(action.url).host;
    case "file.discuss": return `${action.target} · ${action.path}`;
  }
}
