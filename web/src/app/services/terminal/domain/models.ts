import { t, type TextKey } from "../../../i18n/locale";

/** Every failure the interface words itself; a session row keeps the code and the message is translated where it renders. */
export const TERMINAL_NOTES = {
  checking: "fleet.terminal.checking",
  unconfirmed: "fleet.terminal.unconfirmed",
  stillRunning: "fleet.terminal.stillRunning",
  lostBeforeFinish: "fleet.terminal.lostBeforeFinish",
  statusUnknown: "fleet.terminal.statusUnknown",
  noSessionHandle: "fleet.terminal.noSessionHandle",
  checkFailed: "fleet.terminal.checkFailed",
  stopping: "fleet.terminal.stopping",
  commandRequired: "fleet.terminal.commandRequired",
  updateShip: "fleet.terminal.updateShip",
  inputUnconfirmed: "fleet.terminal.inputUnconfirmed",
  sessionLost: "fleet.terminal.sessionLost",
  stopFailed: "fleet.terminal.stopFailed",
  updateShipToStop: "fleet.terminal.updateShipToStop",
} satisfies Record<string, TextKey>;
export type TerminalNote = keyof typeof TERMINAL_NOTES;

/** A failure the interface words itself: its row keeps the note, anything else reads the message in the active language. */
export class TerminalNoteError extends Error {
  constructor(readonly note: TerminalNote) {
    super(t(TERMINAL_NOTES[note]));
  }
}

export type TerminalTarget = {
  id: string;
  label: string;
  online: boolean;
  platform: string;
  description: string;
};

export type TerminalCommandInput = {
  input: string;
  target?: string | null;
  sessionId?: string | null;
  start?: boolean;
  cwd?: string | null;
  timeoutMs?: number | string | null;
  yieldMs?: number | string | null;
  background?: boolean;
};

export type TerminalTranscriptEntry = {
  id: string;
  target: string;
  command: string;
  cwd: string;
  timeoutMs: number | null;
  yieldMs: number | null;
  background: boolean;
  startedAt: number;
  completedAt: number;
  status: "completed" | "running" | "failed";
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number | null;
  sessionId: string | null;
  truncated: boolean;
  /** Why a failed command ended, when the interface words the reason itself instead of the target's own stderr. */
  note?: TerminalNote;
};
