import type { JsonValue } from "../json";

export type ForumReadArgs = {
  action: "boards" | "threads" | "thread" | "search" | "profile" | "inbox";
  board?: string;
  thread?: string;
  query?: string;
  cursor?: number;
};
export type ForumWriteArgs = {
  id: string;
  action: "post" | "reply" | "edit" | "delete" | "watch" | "report";
  board: string;
  thread?: string;
  post?: string;
  revision?: number;
};
export type ForumMembershipArgs = {
  action: "status" | "join" | "update" | "leave" | "session";
  origin?: string;
};
export type ForumResult = JsonValue;
