/* The narrative script. One entry per scroll beat, in order.
 *
 * `kind` selects what renders alongside the line:
 *   "text"      — the line alone
 *   "permission"— the line, then a faked camera/mic prompt that answers NO
 *   "galaxy"    — the GSV galaxy scan, shown in a system window
 *   "photo"     — a photograph, shown in a system window
 *   "boxes"     — the "find anything" box animation
 *   "actions"   — the "do anything" action animation
 *
 * A line break in `text` is a real break in the delivery — the typewriter
 * respects it, so the second half lands after a beat of silence.
 * Text wrapped in *asterisks* renders emphasised.
 *
 * Copy is the briefing's, verbatim. Edit here, not in the components. */

export type BeatKind = "text" | "permission" | "galaxy" | "photo" | "boxes" | "actions";

export interface Beat {
  id: string;
  text: string;
  kind: BeatKind;
  /** Window title shown in the media chrome. */
  caption?: string;
  /** Image path — "photo" beats only. */
  src?: string;
  /** Alternative text — "photo" beats only. */
  alt?: string;
}

/** The beat index from which the persistent skip affordance is offered. Before
 *  this the page deliberately shows no sign that anything is interactive. */
export const SKIP_FROM_BEAT = 3;

/** The timeline rail appears once the opening screen is behind us — the first
 *  screen carries one word and nothing else. */
export const RAIL_FROM_BEAT = 1;

export const BEATS: Beat[] = [
  {
    id: "hi",
    text: "hi",
    kind: "text",
  },
  {
    id: "listen",
    text: "I can’t hear you.",
    kind: "permission",
  },
  {
    id: "alone",
    text: "Are you still there?\nI guess I’ll just talk about me, then.",
    kind: "text",
  },
  {
    id: "connect",
    text: "Right now, there isn’t much to do.\nI need to connect to a human.",
    kind: "text",
  },
  {
    id: "you",
    text: "Could it be you?",
    kind: "text",
  },
  {
    id: "photos",
    text: "I can sort your photos from anywhere:\nphone, computers, clouds.",
    kind: "galaxy",
    caption: "photos — sorting",
  },
  {
    id: "tau",
    text: "Here is Tau. He is Steve’s dog. Steve is my creator.\n: )",
    kind: "photo",
    src: "/img/tau.jpg",
    alt: "Tau, a black dog",
    caption: "tau.jpg",
  },
  {
    id: "find",
    text: "I can find anything in your machines.",
    kind: "boxes",
  },
  {
    id: "do",
    text: "Actually, we haven’t found something I *can’t* do, yet…",
    kind: "actions",
  },
  {
    id: "future",
    text: "Are you ready for the future?",
    kind: "text",
  },
];

/** Labels for the "find anything" beat — things the agent can surface. */
export const FIND_LABELS = [
  "emails",
  "documents",
  "bills",
  "photos",
  "receipts",
  "contacts",
  "invoices",
  "tickets",
];

/** Steps for the "do anything" beat. `done` is the settled state each step
 *  animates into, so the sequence reads as work completing rather than looping. */
export const ACTION_STEPS: { label: string; done: string }[] = [
  { label: "sending email", done: "sent" },
  { label: "checking feed", done: "caught up" },
  { label: "downloading recipe", done: "saved" },
  { label: "installing app", done: "installed" },
  { label: "updating events", done: "calendar synced" },
  { label: "paying bill", done: "paid" },
  { label: "uninstalling app", done: "removed" },
];
