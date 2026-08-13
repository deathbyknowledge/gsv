import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AccountStore } from "./store";

function store(): AccountStore {
  return new AccountStore(env.ACCOUNT_DB, "gsv.space");
}

async function createVerifiedPrincipal(suffix: string): Promise<string> {
  const principalId = `principal_${suffix}`;
  await store().createPrincipal({
    principalId,
    email: `${suffix}@example.com`,
    displayName: suffix,
    verified: true,
  });
  return principalId;
}

describe("account directory", () => {
  it("atomically reserves a handle for a verified principal", async () => {
    const principalId = await createVerifiedPrincipal("reserve");
    const reservation = await store().reserveInstallation({
      principalId,
      operationId: "op_reserve",
      handle: "reserved-home",
    });

    expect(reservation).toMatchObject({
      ownerPrincipalId: principalId,
      handle: "reserved-home",
      canonicalOrigin: "https://reserved-home.gsv.space",
      state: "reserved",
      operationState: "reserved",
    });
    await expect(store().resolveHostname("RESERVED-HOME.GSV.SPACE.")).resolves.toMatchObject({
      found: true,
      state: "reserved",
      installationId: reservation.installationId,
    });
  });

  it("returns the same reservation when an operation is replayed", async () => {
    const principalId = await createVerifiedPrincipal("replay");
    const first = await store().reserveInstallation({
      principalId,
      operationId: "op_replay",
      handle: "replay-home",
    });
    const second = await store().reserveInstallation({
      principalId,
      operationId: "op_replay",
      handle: "replay-home",
    });

    expect(second).toEqual(first);
  });

  it("rejects an operation replayed with different input", async () => {
    const principalId = await createVerifiedPrincipal("replay_mismatch");
    await store().reserveInstallation({
      principalId,
      operationId: "op_replay_mismatch",
      handle: "replay-mismatch",
    });

    await expect(store().reserveInstallation({
      principalId,
      operationId: "op_replay_mismatch",
      handle: "different-handle",
    })).rejects.toThrow("operationId was already used for a different reservation");
  });

  it("lets only one principal claim a handle", async () => {
    const firstPrincipal = await createVerifiedPrincipal("race_a");
    const secondPrincipal = await createVerifiedPrincipal("race_b");
    const attempts = await Promise.allSettled([
      store().reserveInstallation({
        principalId: firstPrincipal,
        operationId: "op_race_a",
        handle: "race-home",
      }),
      store().reserveInstallation({
        principalId: secondPrincipal,
        operationId: "op_race_b",
        handle: "race-home",
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "handle is unavailable" }),
    });
  });

  it("does not reserve for an unverified principal", async () => {
    await store().createPrincipal({
      principalId: "principal_unverified",
      email: "unverified@example.com",
      displayName: "Unverified",
    });

    await expect(store().reserveInstallation({
      principalId: "principal_unverified",
      operationId: "op_unverified",
      handle: "unverified-home",
    })).rejects.toThrow("verified active principal is required");
    await expect(store().resolveHostname("unverified-home.gsv.space")).resolves.toEqual({
      found: false,
    });
  });

  it("keeps published product hostnames unavailable as installation handles", async () => {
    const principalId = await createVerifiedPrincipal("reserved_names");
    for (const handle of ["deploy", "docs", "install", "staging", "www"]) {
      await expect(store().reserveInstallation({
        principalId,
        operationId: `op_reserved_${handle}`,
        handle,
      })).rejects.toThrow("handle is reserved");
    }

    await expect(store().reserveInstallation({
      principalId,
      operationId: "op_internal_service_name",
      handle: "accounts",
    })).resolves.toMatchObject({ handle: "accounts" });
  });

  it("distinguishes unknown and retired hostnames from inactive installations", async () => {
    const principalId = await createVerifiedPrincipal("lifecycle");
    const reservation = await store().reserveInstallation({
      principalId,
      operationId: "op_lifecycle",
      handle: "lifecycle-home",
    });

    await expect(store().resolveHostname("lifecycle-home.gsv.space")).resolves.toMatchObject({
      found: true,
      state: "reserved",
    });
    await expect(store().resolveHostname("unknown.gsv.space")).resolves.toEqual({ found: false });
    await env.ACCOUNT_DB.prepare(
      "UPDATE hostnames SET state = 'retired' WHERE installation_id = ?",
    ).bind(reservation.installationId).run();
    await expect(store().resolveHostname("lifecycle-home.gsv.space")).resolves.toEqual({
      found: false,
    });
  });

  it("resolves lifecycle state by immutable installation id", async () => {
    const principalId = await createVerifiedPrincipal("lifecycle_id");
    const reservation = await store().reserveInstallation({
      principalId,
      operationId: "op_lifecycle_id",
      handle: "lifecycle-id",
    });
    await env.ACCOUNT_DB.prepare(
      "UPDATE installations SET state = 'restricted' WHERE id = ?",
    ).bind(reservation.installationId).run();

    await expect(
      store().resolveInstallation(reservation.installationId),
    ).resolves.toMatchObject({
      found: true,
      installationId: reservation.installationId,
      handle: "lifecycle-id",
      state: "restricted",
    });
    await expect(store().resolveInstallation("invalid id")).resolves.toEqual({
      found: false,
    });
    await expect(store().resolveInstallation("inst_unknown")).resolves.toEqual({
      found: false,
    });
  });

  it("rejects malformed hostname lookups without querying a different name", async () => {
    await expect(store().resolveHostname("")).resolves.toEqual({ found: false });
    await expect(store().resolveHostname("https://hank.gsv.space")).resolves.toEqual({
      found: false,
    });
    await expect(store().resolveHostname(`${"a".repeat(254)}.gsv.space`)).resolves.toEqual({
      found: false,
    });
  });
});
