import type { OwnerConfirmationChange, OwnerNotice } from "@humansandmachines/gsv/services/owner-confirmations";
import { ownerEmailHtml } from "./owner-verification-email";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ACTIONS = {
  made: "make your recovery sheet",
  replaced: "make a new recovery sheet",
  removed: "remove your recovery sheet",
} satisfies Record<OwnerConfirmationChange, string>;
const ADVICE = "If it was you, there’s nothing to do. If it wasn’t, reply within 3 days and we’ll undo it.";

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

/** Tells the owner a recovery sheet change was made, in time for one they didn't make to be undone. */
export function ownerNoticeEmail(notice: Pick<OwnerNotice, "change" | "ship" | "sheetCode">, now: number) {
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
  return {
    subject,
    text: `${body}\n\n${ADVICE}\n\nShip`,
    html: ownerEmailHtml([{ text: body }, { text: ADVICE }]),
  };
}

/** A time every reader can place, such as `25 October 2026 at 15:40 UTC`. */
function moment(at: number): string {
  const date = new Date(at);
  const time = [date.getUTCHours(), date.getUTCMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} at ${time} UTC`;
}
