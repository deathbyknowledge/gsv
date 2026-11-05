import * as z from "zod/mini";

/** The most replies one message offers; a WhatsApp list shows ten rows. */
export const MESSAGE_CHOICE_LIMIT = 10;

/** The longest reply one message offers, in characters: a few words. */
export const MESSAGE_CHOICE_LENGTH_LIMIT = 80;

/**
 * Replies a message offers the person. Each is one short line; tapping it sends
 * that text as the person's next message, and they can always write anything
 * else instead.
 */
export const messageChoicesSchema = z.array(
  z.string().check(
    z.minLength(1),
    z.refine((choice) => choice === choice.trim() && !/[\r\n]/u.test(choice), "Each choice is one line without surrounding spaces"),
    z.refine((choice) => [...choice].length <= MESSAGE_CHOICE_LENGTH_LIMIT, `Each choice is at most ${MESSAGE_CHOICE_LENGTH_LIMIT} characters`),
  ),
).check(
  z.minLength(1),
  z.maxLength(MESSAGE_CHOICE_LIMIT),
  z.refine((choices) => new Set(choices).size === choices.length, "Choices are distinct"),
);

/** A message's choices written into its text, for a messenger that can't show them as buttons. */
export function messageChoicesText(text: string, choices: readonly string[]): string {
  const list = choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n");
  return text ? `${text}\n\n${list}` : list;
}
