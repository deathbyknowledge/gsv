import { bodyFromText, type ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { InstallationOwnerConfirmationService, OwnerConfirmationRequestResult } from "@humansandmachines/gsv/services/owner-confirmations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import { handleRecoveryGet, handleRecoverySet, RECOVERY_PASSWORD_WINDOW_MS, RecoverySheetStore } from "./recovery-sheet";

const OWNER: ProcessIdentity = { uid: 1000, gid: 1000, gids: [100, 1000], username: "alice", home: "/home/alice", cwd: "/home/alice" };
const ACCOUNT = { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "alice.ship.space", host: "https://pds.ship.space" };
const PASSWORD = "correct horse";
const CODE = "424242";
// The sheets from the derivation's fixed vectors, with their sheet codes.
const SHEET = "did:key:zDnaewGvRNmdcuZt2bW7LxUWxazHNEUMBQmpF9UqyVVVs19Hk";
const SHEET_CODE = "E35-BAN";
const NEXT_SHEET = "did:key:zDnaeawtd1GGcWMADtNZPXHbhGtfX7F3dPFfh116iVeEz62yp";
const NEXT_SHEET_CODE = "PJW-P30";
const SENT: OwnerConfirmationRequestResult = { status: "sent", to: "a•••@example.com", expiresAt: 2_000, retryAt: 1_060 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("making, replacing and removing the recovery sheet", () => {
  it("lists a sheet's public key once the password and the emailed code check out, and announces it", async () => {
    const { ctx, repository, confirmations } = harness();
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation())).toEqual({ status: "code-sent", to: "a•••@example.com", expiresAt: 2_000, retryAt: 1_060 });
    expect(confirmations.requestOwnerConfirmation).toHaveBeenCalledExactlyOnceWith({
      installationId: "inst_alice", purpose: "recovery-sheet", subjectHash: expect.stringMatching(/^[0-9a-f]{64}$/), change: "made", ship: ACCOUNT.handle,
    });
    expect(repository.setOwnerRecoveryKey).not.toHaveBeenCalled();

    const done = await handleRecoverySet({ key: SHEET }, ctx, confirmation(CODE));
    expect(done).toEqual({ status: "done", sheet: { code: SHEET_CODE, madeAt: expect.any(Number), pending: false } });
    expect(repository.setOwnerRecoveryKey).toHaveBeenCalledExactlyOnceWith(SHEET);
    expect(confirmations.notifyOwner).toHaveBeenCalledExactlyOnceWith({
      installationId: "inst_alice", purpose: "recovery-sheet", change: "made", ship: ACCOUNT.handle, sheetCode: SHEET_CODE,
    });
    expect(await handleRecoveryGet(ctx)).toEqual({ available: true, identity: { did: ACCOUNT.did, handle: ACCOUNT.handle }, sheet: done.status === "done" ? done.sheet : null });
  });

  it("confirms a replacement and a removal each with its own code, and announces both", async () => {
    const { ctx, repository, confirmations } = harness({ key: SHEET });
    await handleRecoverySet({ key: NEXT_SHEET }, ctx, confirmation());
    expect(confirmations.requestOwnerConfirmation).toHaveBeenLastCalledWith(expect.objectContaining({ change: "replaced" }));
    expect(await handleRecoverySet({ key: NEXT_SHEET }, ctx, confirmation(CODE))).toMatchObject({ status: "done", sheet: { code: NEXT_SHEET_CODE } });

    await handleRecoverySet({ key: null }, ctx, confirmation());
    expect(confirmations.requestOwnerConfirmation).toHaveBeenLastCalledWith(expect.objectContaining({ change: "removed" }));
    const [replacing, removing] = confirmations.requestOwnerConfirmation.mock.calls.map(([input]) => input.subjectHash);
    expect(replacing).not.toBe(removing);
    expect(await handleRecoverySet({ key: null }, ctx, confirmation(CODE))).toEqual({ status: "done", sheet: null });
    expect(repository.setOwnerRecoveryKey.mock.calls).toEqual([[NEXT_SHEET], [null]]);
    expect(confirmations.notifyOwner.mock.calls.map(([notice]) => [notice.change, notice.sheetCode])).toEqual([
      ["replaced", NEXT_SHEET_CODE], ["removed", NEXT_SHEET_CODE],
    ]);
  });

  it("changes nothing for a wrong or expired code, or a code sent for another change", async () => {
    const { ctx, repository, confirmations } = harness();
    await handleRecoverySet({ key: SHEET }, ctx, confirmation());
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation("000000"))).toEqual({ status: "refused", reason: "code", attemptsLeft: 4 });
    expect(await handleRecoverySet({ key: NEXT_SHEET }, ctx, confirmation(CODE))).toEqual({ status: "refused", reason: "code", attemptsLeft: 4 });
    confirmations.confirmOwnerConfirmation.mockResolvedValueOnce({ status: "expired" });
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation(CODE))).toEqual({ status: "refused", reason: "code-expired" });
    expect(repository.setOwnerRecoveryKey).not.toHaveBeenCalled();
    expect(confirmations.notifyOwner).not.toHaveBeenCalled();
  });

  it("finishes a confirmed change the directory hadn't taken without asking for a new code, and announces it once", async () => {
    const { ctx, repository, confirmations } = harness({ key: SHEET, pending: true });
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation())).toEqual({ status: "done", sheet: { code: SHEET_CODE, madeAt: expect.any(Number), pending: false } });
    expect(confirmations.requestOwnerConfirmation).not.toHaveBeenCalled();
    expect(repository.setOwnerRecoveryKey).toHaveBeenCalledExactlyOnceWith(SHEET);
    await handleRecoverySet({ key: SHEET }, ctx, confirmation());
    expect(confirmations.notifyOwner).toHaveBeenCalledOnce();
  });

  it("keeps the change when its notice can't be sent", async () => {
    const { ctx, repository, confirmations } = harness();
    confirmations.notifyOwner.mockRejectedValueOnce(new Error("Accounts couldn't email the notice"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleRecoverySet({ key: SHEET }, ctx, confirmation());
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation(CODE))).toMatchObject({ status: "done", sheet: { code: SHEET_CODE } });
    expect(repository.setOwnerRecoveryKey).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("the password", () => {
  it("reads the password and code only from the request body, never the arguments", async () => {
    const { ctx, repository } = harness();
    // SAFETY: a caller can put anything in the arguments; the handler reads only the key from them.
    const args = { key: SHEET, password: PASSWORD } as never;
    await expect(handleRecoverySet(args, ctx, undefined)).rejects.toThrow("requires the password as its request body");
    expect(ctx.auth.authenticate).not.toHaveBeenCalled();
    expect(repository.ownerRecoveryKey).not.toHaveBeenCalled();
  });

  it("refuses a wrong password before anything else, and asks Accounts nothing", async () => {
    const { ctx, confirmations } = harness();
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation(undefined, "wrong"))).toEqual({ status: "refused", reason: "password" });
    expect(confirmations.requestOwnerConfirmation).not.toHaveBeenCalled();
  });

  it("takes an attempt before checking, so five wrong passwords in 15 minutes stop even parallel tries", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const { ctx } = harness();
    const tries = await Promise.all(Array.from({ length: 7 }, () => handleRecoverySet({ key: SHEET }, ctx, confirmation(undefined, "wrong"))));
    expect(tries.filter((result) => result.status === "refused" && result.reason === "password")).toHaveLength(5);
    expect(tries.filter((result) => result.status === "refused" && result.reason === "attempts")).toEqual([
      { status: "refused", reason: "attempts", retryAt: 1_000_000 + RECOVERY_PASSWORD_WINDOW_MS },
      { status: "refused", reason: "attempts", retryAt: 1_000_000 + RECOVERY_PASSWORD_WINDOW_MS },
    ]);
    expect(ctx.auth.authenticate).toHaveBeenCalledTimes(5);
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation())).toMatchObject({ status: "refused", reason: "attempts" });

    vi.setSystemTime(1_000_000 + RECOVERY_PASSWORD_WINDOW_MS);
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation())).toMatchObject({ status: "code-sent" });
  });

  it("counts only wrong passwords", async () => {
    const { ctx } = harness();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation())).toMatchObject({ status: "code-sent" });
    }
  });
});

describe("the emailed code", () => {
  it("lets the password alone confirm a change only where Accounts sends no email", async () => {
    const { ctx, repository, confirmations } = harness({ request: { status: "not-configured" } });
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation())).toMatchObject({ status: "done", sheet: { code: SHEET_CODE } });
    expect(confirmations.confirmOwnerConfirmation).not.toHaveBeenCalled();
    expect(repository.setOwnerRecoveryKey).toHaveBeenCalledExactlyOnceWith(SHEET);
  });

  it.each<[string, OwnerConfirmationRequestResult, unknown]>([
    ["a code sent too recently", { status: "wait", retryAt: 5_000 }, { status: "refused", reason: "wait", retryAt: 5_000 }],
    ["an owner with no verified address", { status: "no-address" }, { status: "refused", reason: "no-address" }],
  ])("never falls back to the password alone for %s", async (_, request, refusal) => {
    const { ctx, repository } = harness({ request });
    expect(await handleRecoverySet({ key: SHEET }, ctx, confirmation())).toEqual(refusal);
    expect(repository.setOwnerRecoveryKey).not.toHaveBeenCalled();
  });

  it("never falls back to the password alone when Accounts fails", async () => {
    const { ctx, repository, confirmations } = harness();
    confirmations.requestOwnerConfirmation.mockRejectedValueOnce(new Error("Accounts couldn't email the confirmation code"));
    await expect(handleRecoverySet({ key: SHEET }, ctx, confirmation())).rejects.toThrow("Accounts couldn't email the confirmation code");
    confirmations.confirmOwnerConfirmation.mockRejectedValueOnce(new Error("D1 is unavailable"));
    await expect(handleRecoverySet({ key: SHEET }, ctx, confirmation(CODE))).rejects.toThrow("D1 is unavailable");
    expect(repository.setOwnerRecoveryKey).not.toHaveBeenCalled();
  });
});

describe("who can reach the sheet", () => {
  it.each<[string, Partial<KernelContext>]>([
    ["the Ship's process", { processId: "proc:ship" }],
    // SAFETY: the gate reads only whether a tool owner is present.
    ["a tool acting for a process", { toolOwner: { processId: "proc:ship", runId: "run", callId: "call" } as never }],
    // SAFETY: the gate reads only the provenance's kind.
    ["a messenger acting for the person", { peer: { ...testPeer({ account: OWNER, calls: ["atproto.*"] }), provenance: { kind: "adapter-link" } as never } }],
    ["a service", { peer: { ...testPeer({ account: OWNER, calls: ["atproto.*"] }), transport: { kind: "service-binding", serviceId: "app" } } }],
    ["a machine", { peer: testPeer({ kind: "machine", account: OWNER, calls: ["atproto.*"] }) }],
    ["root", { peer: testPeer({ account: { ...OWNER, uid: 0, username: "root" }, calls: ["*"] }) }],
    ["a call outside a session", { connection: null }],
  ])("refuses %s, and touches nothing", async (_, overrides) => {
    const { ctx, repository, confirmations } = harness({ overrides });
    await expect(handleRecoveryGet(ctx)).rejects.toThrow("Only the person signed in to this Ship");
    await expect(handleRecoverySet({ key: SHEET }, ctx, confirmation())).rejects.toThrow("Only the person signed in to this Ship");
    expect(ctx.auth.authenticate).not.toHaveBeenCalled();
    expect(repository.ownerRecoveryKey).not.toHaveBeenCalled();
    expect(confirmations.requestOwnerConfirmation).not.toHaveBeenCalled();
  });

  it("asks a session whose password changed since it signed in to sign in again", async () => {
    const { ctx } = harness({ credentialEpoch: 1 });
    await expect(handleRecoverySet({ key: SHEET }, ctx, confirmation())).rejects.toThrow("sign in again");
    expect(ctx.auth.authenticate).not.toHaveBeenCalled();
  });
});

describe("whether a sheet can be made", () => {
  it("offers a sheet only once the Ship has its identity, and never creates one", async () => {
    const { ctx, repository } = harness({ account: false });
    expect(await handleRecoveryGet(ctx)).toEqual({ available: false, identity: null, sheet: null });
    await expect(handleRecoverySet({ key: SHEET }, ctx, confirmation())).rejects.toThrow("no identity on the open network yet");
    expect(repository.ensureAccount).not.toHaveBeenCalled();
  });

  it("offers none without the PDS or Accounts' confirmations", async () => {
    for (const missing of ["PDS", "INSTALLATION_OWNER_CONFIRMATIONS"] as const) {
      const { ctx } = harness();
      // SAFETY: a deployment may leave either binding out, as this does.
      delete (ctx.env as Partial<KernelContext["env"]>)[missing];
      expect(await handleRecoveryGet(ctx)).toEqual({ available: false, identity: null, sheet: null });
      await expect(handleRecoverySet({ key: SHEET }, ctx, confirmation())).rejects.toThrow("aren't available on this deployment");
    }
  });

  it("shows a sheet it holds no record of making without a date, and one the directory hasn't taken as pending", async () => {
    const { ctx } = harness({ key: SHEET, pending: true });
    expect(await handleRecoveryGet(ctx)).toEqual({ available: true, identity: { did: ACCOUNT.did, handle: ACCOUNT.handle }, sheet: { code: SHEET_CODE, madeAt: null, pending: true } });
  });

  it("takes only a did:key as the sheet's public half", async () => {
    const { ctx } = harness();
    await expect(handleRecoverySet({ key: "z42tnRekTm23DJg8zCE8SfEy19MNf2irnT9zcCAmamcFVEvR" }, ctx, confirmation())).rejects.toThrow();
    expect(ctx.auth.authenticate).not.toHaveBeenCalled();
  });
});

function confirmation(code?: string, password = PASSWORD) {
  return bodyFromText(JSON.stringify(code === undefined ? { password } : { password, code }));
}

function harness(options: {
  account?: boolean; key?: string | null; pending?: boolean; request?: OwnerConfirmationRequestResult;
  credentialEpoch?: number; overrides?: Partial<KernelContext>;
} = {}) {
  const listed = { ownerRecoveryKey: options.key ?? null, pending: options.pending ?? false };
  const repository = {
    account: vi.fn(async () => options.account === false ? null : ACCOUNT),
    ensureAccount: vi.fn(),
    ownerRecoveryKey: vi.fn(async () => options.account === false ? null : { ...listed }),
    setOwnerRecoveryKey: vi.fn(async (key: string | null) => {
      Object.assign(listed, { ownerRecoveryKey: key, pending: false });
      return { ownerRecoveryKey: key };
    }),
    [Symbol.dispose]: vi.fn(),
  };
  let requested: string | null = null;
  const confirmations = {
    requestOwnerConfirmation: vi.fn<InstallationOwnerConfirmationService["requestOwnerConfirmation"]>(async (input) => {
      requested = input.subjectHash;
      return options.request ?? SENT;
    }),
    confirmOwnerConfirmation: vi.fn<InstallationOwnerConfirmationService["confirmOwnerConfirmation"]>(async (input) =>
      input.code === CODE && input.subjectHash === requested ? { status: "confirmed" } : { status: "wrong", attemptsLeft: 4 }),
    notifyOwner: vi.fn<InstallationOwnerConfirmationService["notifyOwner"]>(async () => ({ sent: true })),
  };
  const values = new Map<string, unknown>();
  const storage = {
    kv: {
      get: (key: string) => structuredClone(values.get(key)),
      put: <T>(key: string, value: T) => void values.set(key, structuredClone(value)),
      delete: (key: string) => values.delete(key),
    },
  };
  // SAFETY: the handlers use only the caller, session, password check, bindings and sheet store here,
  // and the store only these storage.kv calls.
  const ctx: KernelContext = {
    installationId: "inst_alice",
    env: { PDS: { getInstallation: async () => repository }, INSTALLATION_OWNER_CONFIRMATIONS: confirmations },
    peer: testPeer({ account: OWNER, calls: ["atproto.*"] }),
    connection: { state: { step: "connected", credentialEpoch: 0 } },
    auth: {
      getHumanAccount: () => ({ uid: OWNER.uid, gid: OWNER.gid, username: OWNER.username, home: OWNER.home }),
      credentialEpoch: () => options.credentialEpoch ?? 0,
      authenticate: vi.fn(async (_username: string, password: string) => password === PASSWORD ? { ok: true } : { ok: false, error: "Authentication failed" }),
    },
    recoverySheet: new RecoverySheetStore(storage as never),
    requestSignal: new AbortController().signal,
    ...options.overrides,
  } as never;
  return { ctx, repository, confirmations };
}
