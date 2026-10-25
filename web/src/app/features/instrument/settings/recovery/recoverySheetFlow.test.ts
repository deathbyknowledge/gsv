import type { GSVClient } from "@humansandmachines/gsv/client";
import { bodyToText, type AtprotoRecoverySetArgs, type BinaryBody } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { changeRecoverySheet, mismatchedWord, recoverySheetFlow, type RecoverySheetStep } from "./recoverySheetFlow";
import { makeRecoverySheet, type RecoverySheetDraft } from "./recoverySheetKeys";

const WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow".split(" ");
const DRAFT: RecoverySheetDraft = { words: WORDS, key: "did:key:zDnaeawtd1GGcWMADtNZPXHbhGtfX7F3dPFfh116iVeEz62yp", code: "PJW-P30", qr: [[true]] };

describe("changing the sheet", () => {
  it("sends only the sheet's public half, with the password and code as the request body", async () => {
    // The second fixed vector's entropy, so the test knows the private key the sheet holds.
    vi.spyOn(crypto, "getRandomValues").mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint8Array)) throw new Error("The sheet draws its entropy as bytes");
      array.fill(0x7f);
      return array;
    });
    const sheet = await makeRecoverySheet();
    vi.restoreAllMocks();
    const calls: Array<{ call: string; args: AtprotoRecoverySetArgs; body: string }> = [];
    const request = vi.fn(async (call: string, args: AtprotoRecoverySetArgs, options: { body: BinaryBody }) => {
      calls.push({ call, args, body: await bodyToText(options.body) });
      return { data: { status: "code-sent", to: "a•••@example.com", expiresAt: 2, retryAt: 1 } };
    });
    // SAFETY: changeRecoverySheet makes only atproto.recovery.set requests, and reads only their data.
    const client: GSVClient = { request } as never;
    expect(await changeRecoverySheet(client, sheet.key, { password: "correct horse" })).toMatchObject({ status: "code-sent" });
    await changeRecoverySheet(client, sheet.key, { password: "correct horse", code: "424242" });
    expect(calls).toEqual([
      { call: "atproto.recovery.set", args: { key: sheet.key }, body: JSON.stringify({ password: "correct horse" }) },
      { call: "atproto.recovery.set", args: { key: sheet.key }, body: JSON.stringify({ password: "correct horse", code: "424242" }) },
    ]);
    const sent = JSON.stringify(calls);
    for (const word of new Set(sheet.words)) expect(sent).not.toMatch(new RegExp(`\\b${word}\\b`));
    for (const secret of ["7f7f7f7f", "f2e63c62911001b8", "z42tzEVMUGhTswAVhmB438G8FwMCuCrCNc9E9SVPyYC3Xskf"]) expect(sent).not.toContain(secret);
    expect(sheet.words.join(" ")).toBe(WORDS.join(" "));
  });
});

describe("the sheet's words", () => {
  it("are shown once: finishing, closing or leaving drops the draft", () => {
    const shown = recoverySheetFlow(recoverySheetFlow({ step: "idle" }, { type: "start", replacing: false }), { type: "show", draft: DRAFT });
    expect(shown).toEqual({ step: "sheet", draft: DRAFT, replacing: false });
    const finishing = recoverySheetFlow(recoverySheetFlow(shown, { type: "written" }), { type: "check", typed: ["thank", "worth", "thank"] });
    expect(finishing).toEqual({ step: "finish", draft: DRAFT, codeTo: null, refusal: null });
    expect(recoverySheetFlow(finishing, { type: "answer", result: { status: "done", sheet: null } })).toEqual({ step: "idle" });
    expect(recoverySheetFlow(shown, { type: "close" })).toEqual({ step: "idle" });
    expect(recoverySheetFlow(finishing, { type: "close" })).toEqual({ step: "idle" });
  });

  it("are checked at words 3, 7 and 11, ignoring case and spaces", () => {
    expect(mismatchedWord(WORDS, [" Thank", "worth ", "THANK"])).toBeNull();
    expect(mismatchedWord(WORDS, ["thank", "worth", "yellow"])).toBe(11);
    expect(mismatchedWord(WORDS, ["year", "worth", "thank"])).toBe(3);
    const checking: RecoverySheetStep = { step: "check", draft: DRAFT, replacing: true, mismatch: null };
    expect(recoverySheetFlow(checking, { type: "check", typed: ["thank", "wave", "thank"] })).toEqual({ ...checking, mismatch: 7 });
    expect(recoverySheetFlow(checking, { type: "back" })).toEqual({ step: "sheet", draft: DRAFT, replacing: true });
  });
});

describe("confirming the change", () => {
  it("asks for the code Accounts sent, and for a new one once a code expires", () => {
    const finishing: RecoverySheetStep = { step: "finish", draft: null, codeTo: null, refusal: null };
    const sent = recoverySheetFlow(finishing, { type: "answer", result: { status: "code-sent", to: "a•••@example.com", expiresAt: 2, retryAt: 1 } });
    expect(sent).toEqual({ ...finishing, codeTo: "a•••@example.com" });
    const wrong = recoverySheetFlow(sent, { type: "answer", result: { status: "refused", reason: "code", attemptsLeft: 3 } });
    expect(wrong).toEqual({ ...sent, refusal: { status: "refused", reason: "code", attemptsLeft: 3 } });
    expect(recoverySheetFlow(wrong, { type: "answer", result: { status: "refused", reason: "code-expired" } }))
      .toEqual({ ...finishing, refusal: { status: "refused", reason: "code-expired" } });
  });
});
