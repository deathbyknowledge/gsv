import { z } from "zod/mini";

const id = z.string().check(z.minLength(1), z.maxLength(256));
const name = z.string().check(z.minLength(1), z.maxLength(256));
const note = z.optional(z.string().check(z.maxLength(32_768)));

/** An explicit human request with a readable text projection for every client and Process. */
export const conversationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("routine.create"), note }),
  z.strictObject({ kind: z.literal("machine.connect"), note }),
  z.strictObject({ kind: z.literal("browser.start"), note }),
  z.strictObject({ kind: z.literal("routine.discuss"), id, name, note }),
  z.strictObject({ kind: z.literal("responsibility.discuss"), id, name, note }),
  z.strictObject({ kind: z.literal("profile.discuss"), name,
    url: z.url({ protocol: /^https?$/ }).check(z.maxLength(2048)), note }),
  z.strictObject({ kind: z.literal("file.discuss"), target: id,
    path: z.string().check(z.minLength(1), z.maxLength(4096)), note }),
]);

export type ConversationAction = { note?: string } & (
  | { kind: "routine.create" }
  | { kind: "machine.connect" }
  | { kind: "browser.start" }
  | { kind: "routine.discuss"; id: string; name: string }
  | { kind: "responsibility.discuss"; id: string; name: string }
  | { kind: "profile.discuss"; name: string; url: string }
  | { kind: "file.discuss"; target: string; path: string }
);

/** This projection is ordinary user input; action metadata grants no additional authority. */
export function conversationActionText(action: ConversationAction): string {
  let request: string;
  switch (action.kind) {
    case "routine.create": request = "Help me create a routine."; break;
    case "machine.connect": request = "Help me connect a computer to this space."; break;
    case "browser.start": request = "Start a browser for me."; break;
    case "routine.discuss": request = `Help me with the routine ${JSON.stringify(action.name)} (${action.id}).`; break;
    case "responsibility.discuss": request = `Help me with the responsibility ${JSON.stringify(action.name)} (${action.id}).`; break;
    case "profile.discuss": request = `Help me with ${JSON.stringify(action.name)}'s GSV profile: ${action.url}`; break;
    case "file.discuss": request = `Use this file as context: @${action.target} ${action.path}`; break;
  }
  return action.note ? `${request}\n\n${action.note}` : request;
}

export function validateConversationAction(value: ConversationAction, text: string): ConversationAction {
  const action = conversationActionSchema.parse(value);
  if (conversationActionText(action) !== text) throw new Error("Message action does not match its text");
  return action;
}
