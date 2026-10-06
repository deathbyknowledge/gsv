import type { ChatMediaUpload } from "../../../services/chat/domain/processes";
import { chatMediaKind } from "../../../services/chat/domain/media";
import { randomId } from "../../../services/ids";

export type ZenAttachment = ChatMediaUpload & { id: string };

export function zenAttachment(file: File): ZenAttachment {
  const mimeType = file.type || "application/octet-stream";
  return { id: randomId(), type: chatMediaKind({ mimeType }), mimeType, filename: file.name || "attachment", body: file };
}

/** A paste longer than this many characters waits beside the prompt as a chip instead of filling it. */
export const LONG_PASTE_CHARACTERS = 400;
/** A paste with more lines than this folds too, however short its lines are. */
export const LONG_PASTE_LINES = 8;

/** Long pasted text held beside the prompt; it joins the message when it is sent. */
export type ZenPaste = { id: string; text: string; characters: number };

/** The paste as a draft chip, or null when it is short enough to type into the prompt as usual. */
export function longPaste(raw: string): ZenPaste | null {
  // The textarea would normalize line endings; everything else is kept, since blank lines and trailing
  // spaces can carry meaning in Markdown, patches and data blocks.
  const text = raw.replace(/\r\n?/g, "\n");
  const characters = Array.from(text).length;
  const lines = text.split("\n").length;
  if (characters <= LONG_PASTE_CHARACTERS && lines <= LONG_PASTE_LINES) return null;
  return { id: randomId(), text, characters };
}

/** What is sent: the typed words first, then each pasted block in paste order, separated by blank lines. */
export function zenDraftMessage(typed: string, pastes: readonly ZenPaste[]): string {
  return [typed, ...pastes.map((paste) => paste.text)].filter((part) => part.trim()).join("\n\n");
}
