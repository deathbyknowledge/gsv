import { Bash } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApproachState, PublicProfile } from "@humansandmachines/gsv/protocol";
import type { ApproachRecord } from "../../../kernel/approach-store";
import type { KernelContext } from "../../../kernel/context";
import * as admission from "../../../kernel/approaches/admission";
import * as runtime from "../../../kernel/approaches/runtime";
import * as invitations from "../../../kernel/federation/invitations";
import * as profiles from "../../../kernel/profiles";
import { testPeer } from "../../../test-support/peers";
import { buildContactCommand } from "./contact";

type ShellApproaches = Pick<KernelContext["approaches"], "byIdempotencyKey" | "unresolved">;
const OWNER_ACCOUNT = { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" };

function shell(approaches: Partial<ShellApproaches> = {}, caller: { processId?: string } = {}) {
  const store: ShellApproaches = { byIdempotencyKey: () => null, unresolved: () => null, ...approaches };
  // SAFETY: handlers are mocked here; command parsing reads only the caller grant and identity.
  const ctx = {
    approaches: store, connection: caller.processId ? undefined : {}, ...caller,
    peer: testPeer({ account: OWNER_ACCOUNT, calls: ["contact.*", "profile.resolve", "approach.create"] }),
    procs: { get: () => ({ isPersonalController: false, ownerUid: OWNER_ACCOUNT.uid }), getOwnerUid: () => OWNER_ACCOUNT.uid },
    auth: { getPasswdByUid: () => OWNER_ACCOUNT, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
  } as KernelContext;
  return new Bash({ customCommands: [buildContactCommand(ctx)] });
}

afterEach(() => vi.restoreAllMocks());

describe("contact invitation handling", () => {
  it("passes each owner's explicit choice through create and accept", async () => {
    const create = vi.spyOn(invitations, "handleContactInviteCreate").mockResolvedValue({ inviteId: "invite:test", code: "code", url: "https://example.com/connect#contact=code", expiresAtMs: 1 });
    const accept = vi.spyOn(invitations, "handleContactInviteAccept").mockImplementation(async () => { throw new Error("reached acceptance"); });
    const bash = shell();
    expect((await bash.exec("contact invite create --handling ship --expires 7d")).exitCode).toBe(0);
    expect(create).toHaveBeenCalledWith({ shipHandlesMessages: true, expiresInSeconds: 604800 }, expect.anything());
    expect((await bash.exec("contact invite accept 'https://example.com/connect#contact=code' --handling manual")).stderr).toContain("reached acceptance");
    expect(accept).toHaveBeenCalledWith({ code: "https://example.com/connect#contact=code", shipHandlesMessages: false }, expect.anything());
  });

  it("makes no invitation mutation when the handling choice is missing or invalid", async () => {
    const create = vi.spyOn(invitations, "handleContactInviteCreate");
    const accept = vi.spyOn(invitations, "handleContactInviteAccept");
    const bash = shell();
    for (const command of ["contact invite create", "contact invite accept code", "contact invite create --handling auto", "contact invite create --handling manual --handling ship"]) {
      expect((await bash.exec(command)).exitCode).toBe(1);
    }
    expect(create).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("contact connect", () => {
  const profile: PublicProfile = {
    did: "did:plc:adaadaadaadaadaadaadaada", handle: "ada.ship.space", cid: "bafyada", displayName: "Ada", about: "",
    contactPolicy: "requests", url: "https://ada.ship.space/profile",
  };

  it("resolves the handle and sends one message request under the owner's name", async () => {
    const resolve = vi.spyOn(profiles, "handleProfileResolve").mockResolvedValue({ profile });
    vi.spyOn(profiles, "ownerDisplayName").mockReturnValue("Owner Person");
    const create = vi.spyOn(admission, "handleApproachCreate").mockImplementation(async () => { throw new Error("reached create"); });
    const bash = shell();
    expect((await bash.exec("contact connect @ada --message 'Hi Ada' --handling manual")).stderr).toContain("reached create");
    expect(resolve).toHaveBeenCalledWith({ address: "@ada" }, expect.anything());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      did: profile.did, profileCid: profile.cid, displayName: "Owner Person", text: "Hi Ada", shipHandlesMessages: false,
      idempotencyKey: expect.stringMatching(/^connect:[A-Za-z0-9_-]{43}$/),
    }), expect.anything());
    const [first] = create.mock.calls[0];
    await bash.exec("contact connect ada --message 'Hi Ada' --handling ship --name 'Owner (work)'");
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: first.idempotencyKey, displayName: "Owner (work)", shipHandlesMessages: true }), expect.anything());
    await bash.exec("contact connect @ada --message 'Another message' --handling ship");
    expect(create.mock.lastCall?.[0].idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("sends the same text again once the earlier request has ended", async () => {
    vi.spyOn(profiles, "handleProfileResolve").mockResolvedValue({ profile });
    vi.spyOn(profiles, "ownerDisplayName").mockReturnValue("Owner Person");
    const create = vi.spyOn(admission, "handleApproachCreate").mockImplementation(async () => { throw new Error("reached create"); });
    const overdue = (state: "preparing" | "pending") => {
      const record = approachRecord({ id: `approach:overdue-${state}`, state });
      record.summary.expiresAtMs = Date.now() - 1;
      return record;
    };
    for (const ended of [...(["declined", "withdrawn", "expired", "blocked"] as const).map((state) => approachRecord({ id: `approach:${state}`, state })), overdue("preparing"), overdue("pending")]) {
      const keys: string[] = [];
      const bash = shell({ byIdempotencyKey: (_uid, key) => { keys.push(key); return keys.length === 1 ? ended : null; } });
      expect((await bash.exec("contact connect @ada --message 'Hi Ada' --handling manual")).stderr).toContain("reached create");
      expect(create.mock.lastCall?.[0].idempotencyKey).toBe(keys[1]);
      expect(keys[1]).not.toBe(keys[0]);
    }
  });

  it("returns a pending request with the same text and refuses to change its name or handling", async () => {
    vi.spyOn(profiles, "handleProfileResolve").mockResolvedValue({ profile });
    vi.spyOn(profiles, "ownerDisplayName").mockReturnValue("Owner Person");
    const create = vi.spyOn(admission, "handleApproachCreate");
    const pending = approachRecord({ id: "approach:pending", state: "pending" });
    const bash = shell({ byIdempotencyKey: () => pending });
    const same = await bash.exec("contact connect @ada --message 'Hi Ada' --handling manual");
    expect(same.exitCode).toBe(0);
    expect(same.stdout).toContain("approach:pending");
    for (const command of ["contact connect @ada --message 'Hi Ada' --handling ship", "contact connect @ada --message 'Hi Ada' --handling manual --name 'Owner (work)'"]) {
      const changed = await bash.exec(command);
      expect(changed.exitCode).toBe(1);
      expect(changed.stderr).toContain("already waiting for an answer");
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a delegated process before reading or replaying a stored request", async () => {
    const resolve = vi.spyOn(profiles, "handleProfileResolve").mockResolvedValue({ profile });
    const create = vi.spyOn(admission, "handleApproachCreate");
    const lookup = vi.fn(() => approachRecord({ id: "approach:pending", state: "pending" }));
    const result = await shell({ byIdempotencyKey: lookup }, { processId: "proc:crew" }).exec("contact connect @ada --message 'Hi Ada' --handling manual");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("signed-in human or their Ship");
    expect(result.stdout).not.toContain("approach:pending");
    expect(lookup).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("expires the exact overdue request before replacing it while it still reads as pending", async () => {
    vi.spyOn(profiles, "handleProfileResolve").mockResolvedValue({ profile });
    vi.spyOn(profiles, "ownerDisplayName").mockReturnValue("Owner Person");
    const expire = vi.spyOn(runtime, "expireOverdueApproach").mockResolvedValue();
    const create = vi.spyOn(admission, "handleApproachCreate").mockImplementation(async () => { throw new Error("reached create"); });
    const overdue = approachRecord({ id: "approach:overdue", state: "pending" });
    overdue.summary.expiresAtMs = Date.now() - 1;
    const keys: string[] = [];
    const bash = shell({
      byIdempotencyKey: (_uid, key) => { keys.push(key); return keys.length === 1 ? overdue : null; },
      unresolved: () => overdue,
    });
    expect((await bash.exec("contact connect @ada --message 'Hi Ada' --handling manual")).stderr).toContain("reached create");
    expect(expire).toHaveBeenCalledWith(overdue, expect.anything());
    expect(expire.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it("sends nothing without a message or a handling choice", async () => {
    const resolve = vi.spyOn(profiles, "handleProfileResolve");
    const create = vi.spyOn(admission, "handleApproachCreate");
    const bash = shell();
    for (const command of ["contact connect @ada --handling manual", "contact connect @ada --message 'Hi'", "contact connect @ada --message 'Hi' --handling auto", "contact connect"]) {
      expect((await bash.exec(command)).exitCode).toBe(1);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("contact find", () => {
  it("reads the profile an address names, as written", async () => {
    const resolve = vi.spyOn(profiles, "handleProfileResolve").mockImplementation(async () => { throw new Error("reached resolve"); });
    const bash = shell();
    for (const address of ["@ada", "ada.example.com", "https://ada.example.com/profile"]) {
      expect((await bash.exec(`contact find ${address}`)).stderr).toContain("reached resolve");
      expect(resolve).toHaveBeenLastCalledWith({ address }, expect.anything());
    }
  });
});

function approachRecord(summary: { id: string; state: ApproachState }): ApproachRecord {
  // SAFETY: contact connect reads only the summary's id, state and expiry, the handling choice and the sender name.
  return {
    summary: { ...summary, expiresAtMs: summary.state === "expired" ? 1 : Date.now() + 60_000 },
    shipHandlesMessages: false, localDisplayName: "Owner Person",
  } as ApproachRecord;
}
