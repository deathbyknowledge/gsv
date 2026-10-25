import type { OwnerConfirmationChange, OwnerNotice, OwnerNoticeUndo } from "@humansandmachines/gsv/services/owner-confirmations";
import { ownerEmailHtml } from "./owner-verification-email";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ACTIONS = {
  made: "make your recovery sheet",
  replaced: "make a new recovery sheet",
  removed: "remove your recovery sheet",
} satisfies Record<OwnerConfirmationChange, string>;
/** What to do about a change the owner didn't make, promising an undo only from a key that can make one. */
const ADVICE = {
  operator: "If it was you, there’s nothing to do. If it wasn’t, reply within 3 days and we’ll undo it.",
  "previous-sheet": "If it was you, there’s nothing to do. If it wasn’t, reply straight away. For 3 days, your previous sheet can still undo it.",
  none: "If it was you, there’s nothing to do. If it wasn’t, reply straight away.",
} satisfies Record<OwnerNoticeUndo, string>;

/** The code that confirms one change to a Ship's recovery sheet. */
export function ownerConfirmationEmail(change: OwnerConfirmationChange, code: string, expiresAt: number, now: number) {
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  const introduction = `Enter this code in Ship to ${ACTIONS[change]}:`;
  const expiry = `This code expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Don’t share it with anyone.`;
  const footer = "If you didn’t ask for this code, someone may know your Ship password. Change it.";
  return {
    subject: "Your Ship recovery sheet code",
    text: `${introduction}\n\n${code}\n\n${expiry}\n\n${footer}\n\nShip`,
    html: ownerEmailHtml([{ text: introduction }, { text: code, style: "code" }, { text: expiry }, { text: footer, style: "note" }]),
  };
}

/** Tells the owner a recovery sheet change was made, and who can still undo one they didn’t make. */
export function ownerNoticeEmail(notice: Pick<OwnerNotice, "change" | "ship" | "sheetCode" | "undo">, now: number) {
  const subject = {
    made: `A recovery sheet was made for @${notice.ship}`,
    replaced: `A new recovery sheet was made for @${notice.ship}`,
    removed: `The recovery sheet for @${notice.ship} was removed`,
  }[notice.change];
  const done = {
    made: `made a recovery sheet with sheet code ${notice.sheetCode}`,
    replaced: `made a new recovery sheet with sheet code ${notice.sheetCode}, in place of the earlier one`,
    removed: `removed the recovery sheet with sheet code ${notice.sheetCode}`,
  }[notice.change];
  const body = `On ${moment(now)}, someone signed in to your Ship ${done}.`;
  const advice = ADVICE[notice.undo];
  return {
    subject,
    text: `${body}\n\n${advice}\n\nShip`,
    html: ownerEmailHtml([{ text: body }, { text: advice }]),
  };
}

/** A time every reader can place, such as `25 October 2026 at 15:40 UTC`. */
function moment(at: number): string {
  const date = new Date(at);
  const time = [date.getUTCHours(), date.getUTCMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} at ${time} UTC`;
}
