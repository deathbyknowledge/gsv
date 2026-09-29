import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationCreationInvites } from "./creation-invites";

const db = env.INSTALLATIONS_DB;
const accounts = new AccountStore(db, "example.com");
const onboarding = new InstallationOnboardingStore(db, accounts);
const invites = new InstallationCreationInvites(db, accounts, onboarding);
async function owner() {
  const id = `owner_${crypto.randomUUID()}`;
  await accounts.createPrincipal({ principalId: id, email: `${id}@example.com`, displayName: "Owner", verified: true });
  return id;
}
const handle = () => `space-${crypto.randomUUID()}`;

afterEach(() => vi.restoreAllMocks());

describe("space creation invites", () => {
  it("returns the issued code without requiring a separate read after the write", async () => {
    const prepare = db.prepare.bind(db);
    const read = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.trimStart().startsWith("SELECT")) throw new Error("Directory reads unavailable");
      return prepare(sql);
    });
    const issued = await invites.create({ note: "  cohort two  ", policyRef: "early-access", expiresAt: Date.now() + 60_000 });
    read.mockRestore();
    expect((await invites.list()).find((invite) => invite.id === issued.invite.id)).toEqual(issued.invite);
    expect(issued.invite).toMatchObject({ note: "cohort two", policyRef: "early-access", state: "issued" });
    expect((await invites.claim(issued.code, await owner())).id).toBe(issued.invite.id);
  });

  it("stores a hash, lets only one verified owner claim a code, and permits an exact replay", async () => {
    const issued = await invites.create({ note: "cohort one" });
    const [a, b] = await Promise.all([owner(), owner()]);
    const outcomes = await Promise.allSettled([invites.claim(issued.code, a), invites.claim(issued.code, b)]);
    const winners = outcomes.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    if (winners[0].status !== "fulfilled") throw new Error("Missing winner");
    const winner = winners[0].value.principalId!;
    expect((await invites.claim(issued.code, winner)).id).toBe(issued.invite.id);
    expect(JSON.stringify(await db.prepare("SELECT * FROM installation_creation_invites WHERE id = ?").bind(issued.invite.id).first())).not.toContain(issued.code);
  });

  it("keeps an invite usable after an unavailable handle and never creates two spaces", async () => {
    const principalId = await owner();
    const name = handle();
    await accounts.reserveInstallation({ principalId, operationId: crypto.randomUUID(), handle: name });
    const issued = await invites.create({});
    await invites.claim(issued.code, principalId);
    await expect(invites.prepare(issued.invite.id, principalId, name)).rejects.toThrow("unavailable");
    expect((await invites.owned(principalId))[0].state).toBe("claimed");
    const available = handle();
    const prepared = await invites.prepare(issued.invite.id, principalId, available);
    const resumed = await new InstallationCreationInvites(db, accounts, onboarding).prepare(issued.invite.id, principalId, available);
    expect(resumed.space.installationId).toBe(prepared.space.installationId);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM provisioning_operations WHERE operation_id = ?").bind(issued.invite.id).first())?.count).toBe(1);
    expect(await onboarding.authorize({ installationId: resumed.space.installationId, token: resumed.onboardingToken! })).toMatchObject({ ok: true });
    await expect(invites.revoke(issued.invite.id)).rejects.toThrow("already created");
  });

  it("fences revoked/expired invites and never activates before private policy succeeds", async () => {
    const principalId = await owner();
    const expired = await invites.create({ expiresAt: Date.now() + 1 });
    await expect(invites.claim(expired.code, principalId, Date.now() + 100)).rejects.toThrow("unavailable");
    const revoked = await invites.create({});
    await invites.claim(revoked.code, principalId);
    await invites.revoke(revoked.invite.id);
    await expect(invites.prepare(revoked.invite.id, principalId, handle())).rejects.toThrow("unavailable");
    const issued = await invites.create({ policyRef: "early-access" });
    await invites.claim(issued.code, principalId);
    const policy = { prepare: vi.fn(async (): Promise<void> => { throw new Error("private details"); }) };
    const managed = new InstallationCreationInvites(db, accounts, onboarding, policy);
    const name = handle();
    await expect(managed.prepare(issued.invite.id, principalId, name)).rejects.toThrow("temporarily unavailable");
    const reservation = await accounts.getReservationByOperation(issued.invite.id);
    expect(reservation?.state).toBe("reserved");
    expect((await invites.owned(principalId)).find((invite) => invite.id === issued.invite.id)?.lastError).toBe("policy_unavailable");
    await db.prepare("UPDATE installations SET reservation_expires_at = 1 WHERE id = ?").bind(reservation!.installationId).run();
    policy.prepare.mockResolvedValue(undefined);
    expect((await managed.prepare(issued.invite.id, principalId, name)).space.state).toBe("provisioning");
  });

  it("allocates at most one installation when a claimed invite chooses two handles concurrently", async () => {
    const principalId = await owner();
    const issued = await invites.create({});
    await invites.claim(issued.code, principalId);
    const outcomes = await Promise.allSettled([invites.prepare(issued.invite.id, principalId, handle()), invites.prepare(issued.invite.id, principalId, handle())]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM installations WHERE owner_principal_id = ?").bind(principalId).first())?.count).toBe(1);
  });
});
