import type { GSVClient } from "@humansandmachines/gsv/client";
import { bodyFromText, type AtprotoRecoveryConfirmation, type AtprotoRecoverySetResult } from "@humansandmachines/gsv/protocol";
import type { RecoverySheetDraft } from "./recoverySheetKeys";

/** The words, counting from 1, a person types back to show their sheet holds them. */
export const CHECKED_WORDS = [3, 7, 11] as const;

export type RecoverySheetRefusal = Extract<AtprotoRecoverySetResult, { status: "refused" }>;

/**
 * Where the person is in changing their sheet. A draft lives only here, in
 * memory: closing the flow, finishing it or leaving Settings drops it, so its
 * words are shown once and never again.
 */
export type RecoverySheetStep =
  | { step: "idle" }
  | { step: "before"; replacing: boolean }
  | { step: "sheet"; draft: RecoverySheetDraft; replacing: boolean }
  | { step: "check"; draft: RecoverySheetDraft; replacing: boolean; mismatch: number | null }
  /** A null draft removes the sheet. `codeTo` names where the code went once Accounts sent one. */
  | { step: "finish"; draft: RecoverySheetDraft | null; codeTo: string | null; refusal: RecoverySheetRefusal | null };

export type RecoverySheetAction =
  | { type: "start"; replacing: boolean }
  | { type: "show"; draft: RecoverySheetDraft }
  | { type: "written" }
  | { type: "back" }
  | { type: "check"; typed: readonly string[] }
  | { type: "remove" }
  | { type: "answer"; result: AtprotoRecoverySetResult }
  | { type: "close" };

export function recoverySheetFlow(state: RecoverySheetStep, action: RecoverySheetAction): RecoverySheetStep {
  switch (action.type) {
    case "start":
      return { step: "before", replacing: action.replacing };
    case "show":
      return state.step === "before" ? { step: "sheet", draft: action.draft, replacing: state.replacing } : state;
    case "written":
      return state.step === "sheet" ? { step: "check", draft: state.draft, replacing: state.replacing, mismatch: null } : state;
    case "back":
      return state.step === "check" ? { step: "sheet", draft: state.draft, replacing: state.replacing } : state;
    case "check": {
      if (state.step !== "check") return state;
      const mismatch = mismatchedWord(state.draft.words, action.typed);
      return mismatch === null ? { step: "finish", draft: state.draft, codeTo: null, refusal: null } : { ...state, mismatch };
    }
    case "remove":
      return { step: "finish", draft: null, codeTo: null, refusal: null };
    case "answer": {
      if (state.step !== "finish") return state;
      const { result } = action;
      if (result.status === "done") return { step: "idle" };
      if (result.status === "code-sent") return { ...state, codeTo: result.to, refusal: null };
      // An expired code is gone: the next try asks for a new one.
      return { ...state, codeTo: result.reason === "code-expired" ? null : state.codeTo, refusal: result };
    }
    case "close":
      return { step: "idle" };
  }
}

/** The first checked word, counting from 1, that doesn't match the sheet; null when all do. */
export function mismatchedWord(words: readonly string[], typed: readonly string[]): number | null {
  const index = CHECKED_WORDS.findIndex((position, at) => (typed[at] ?? "").trim().toLowerCase() !== words[position - 1]);
  return index < 0 ? null : CHECKED_WORDS[index]!;
}

/**
 * Asks the Ship to list the sheet's public half, or none to remove it. The
 * password and code travel in the request body; nothing else of the sheet
 * leaves the browser.
 */
export async function changeRecoverySheet(client: GSVClient, key: string | null, confirmation: AtprotoRecoveryConfirmation): Promise<AtprotoRecoverySetResult> {
  const body: AtprotoRecoveryConfirmation = confirmation.code === undefined
    ? { password: confirmation.password }
    : { password: confirmation.password, code: confirmation.code };
  const response = await client.request("atproto.recovery.set", { key }, { body: bodyFromText(JSON.stringify(body)) });
  await response.body?.stream.cancel("atproto.recovery.set returns no body");
  return response.data;
}
