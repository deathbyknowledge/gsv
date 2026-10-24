import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  OperatorGatewayService,
  OperatorIdentitySurvey,
  OperatorLegacyPerson,
  OperatorPersonDid,
} from "@humansandmachines/gsv/services/operator";
import { CloudflareInstallationAdminAccess } from "./admin/access";
import { InstallationAdminHttp } from "./admin/http";
import { IDENTITY_MOVE_NAVIGATION } from "./admin/identity-move-page";
import { ShipInsight } from "./admin/insight";
import { InstallationAdminService } from "./admin/service";
import { IdentityMoves } from "./identity-moves";
import { InstallationOnboardingStore } from "./onboarding";
import { AccountStore } from "./store";

const db = env.INSTALLATIONS_DB;
const origin = "http://localhost:8976";
const person = (name: string, letter: string): OperatorPersonDid => ({
  shipId: `ship-${name}`, subjectId: `subject-${name}`, did: `did:plc:${letter.repeat(24)}`, handle: `${name}.ship.test`,
});
const HANK = person("hank", "h");
const MARA = person("mara", "m");
const RUTH = person("ruth", "r");
/** Someone whose Ship is on another deployment, so no survey here names them. */
const FAR: OperatorLegacyPerson = { shipId: "ship-far", subjectId: "subject-far" };
const rows = (contacts: number, deliveries = 0) => ({ contacts, blocks: 0, requests: 0, deliveries });

// Each test surveys only the Ships it creates.
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM identity_moves"),
    db.prepare("UPDATE installations SET state = 'retained' WHERE state IN ('active', 'restricted')"),
  ]);
});

describe("the operator's move to DIDs", () => {
  it("surveys every active and restricted Ship, then gives each the DIDs of the people it names", async () => {
    const hank = await ship("move-hank");
    const mara = await ship("move-mara");
    const ruth = await ship("move-ruth", "restricted");
    const lone = await ship("move-lone");
    await ship("move-gone", "retained");
    const network = fakeGateway(new Map([
      [hank, survey(hank, { person: HANK, references: [MARA, RUTH, FAR], waiting: rows(3, 2), otherAccounts: 1 })],
      [mara, survey(mara, { person: MARA, references: [HANK], waiting: rows(1) })],
      [ruth, survey(ruth, { person: RUTH, references: [HANK], waiting: rows(1) })],
      [lone, survey(lone, {})],
    ]));
    const moves = new IdentityMoves(db, network.gateway);

    expect(await moves.survey()).toMatchObject({ phase: "surveying", ships: { total: 4, surveyed: 0, moved: 0 } });
    await moves.resumePending();
    expect(network.surveyed.toSorted()).toEqual([hank, lone, mara, ruth].toSorted());
    expect(await moves.status()).toMatchObject({
      phase: "ready",
      ships: { total: 4, surveyed: 4, moved: 0 },
      people: { named: 4, withDid: 3, withoutDid: 1 },
      waiting: { contacts: 5, blocks: 0, requests: 0, deliveries: 2 },
      otherAccounts: 1,
      retrying: [],
    });

    expect(await moves.apply()).toMatchObject({ phase: "moving" });
    await moves.resumePending();
    // Each Ship hears its own person and everyone it names who has a DID here.
    expect(network.moved.get(hank)).toEqual([HANK, MARA, RUTH]);
    expect(network.moved.get(mara)).toEqual([MARA, HANK]);
    expect(network.moved.get(ruth)).toEqual([RUTH, HANK]);
    expect(network.moved.get(lone)).toEqual([]);
    expect(await moves.status()).toMatchObject({
      phase: "moved",
      ships: { total: 4, surveyed: 4, moved: 4 },
      moved: { contacts: 7, blocks: 0, requests: 0, deliveries: 0, messages: 7 },
      ended: { contacts: 4, blocks: 0, requests: 0, deliveries: 0, messages: 0 },
    });
    // A finished move runs nothing more.
    await moves.resumePending();
    expect(network.gateway.operatorIdentityMove).toHaveBeenCalledTimes(4);
  });

  it("tries a failed survey again later, and applies the move only once every Ship has answered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const steady = await ship("move-steady");
    const flaky = await ship("move-flaky");
    const network = fakeGateway(new Map([[steady, survey(steady, { person: HANK })], [flaky, survey(flaky, { person: MARA })]]));
    network.failNext.set(flaky, new Error("The Kernel was reset because its code was updated"));
    let now = 1_000_000;
    const moves = new IdentityMoves(db, network.gateway, () => now);
    await moves.survey();
    await moves.resumePending();
    expect((await moves.status()).retrying).toEqual([{
      installationId: flaky, handle: "move-flaky", state: "surveying", attempts: 1,
      error: "The Kernel was reset because its code was updated", nextAttemptAt: now + 60_000,
    }]);
    expect(warn).toHaveBeenCalledWith("[Operator] Identity move attempt failed:", flaky, "surveying",
      expect.objectContaining({ exceptionMessage: "The Kernel was reset because its code was updated" }));
    await expect(moves.apply()).rejects.toMatchObject({ message: "Every Ship must answer its survey before the move", status: 409 });

    now += 30_000;
    await moves.resumePending();
    expect(network.surveyed.filter((id) => id === flaky)).toHaveLength(1);
    now += 31_000;
    await moves.resumePending();
    expect(await moves.status()).toMatchObject({ phase: "ready", retrying: [] });
  });

  it("starts over when surveyed again, without the Ships the directory no longer holds", async () => {
    const first = await ship("move-first");
    const second = await ship("move-second");
    const surveys = new Map([
      [first, survey(first, { person: HANK, references: [MARA], waiting: rows(1) })],
      [second, survey(second, { person: MARA, references: [HANK], waiting: rows(1) })],
    ]);
    const moves = new IdentityMoves(db, fakeGateway(surveys).gateway);
    await moves.survey();
    await moves.resumePending();
    expect(await moves.status()).toMatchObject({ phase: "ready", people: { named: 2, withDid: 2 }, waiting: { contacts: 2 } });

    await db.prepare("UPDATE installations SET state = 'retained' WHERE id = ?").bind(second).run();
    surveys.set(first, survey(first, { person: HANK, references: [MARA, RUTH], waiting: rows(2) }));
    expect(await moves.survey()).toMatchObject({
      phase: "surveying", ships: { total: 1, surveyed: 0 }, people: { named: 0 }, waiting: { contacts: 0 },
    });
    await moves.resumePending();
    // Mara's Ship has left the directory, so the move no longer knows her DID.
    expect(await moves.status()).toMatchObject({
      phase: "ready", ships: { total: 1, surveyed: 1 }, people: { named: 2, withDid: 0, withoutDid: 2 }, waiting: { contacts: 2 },
    });
  });

  it("never tries one Ship from two jobs at once", async () => {
    const busy = await ship("move-busy");
    const network = fakeGateway(new Map([[busy, survey(busy, { person: HANK })]]));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const answer = network.gateway.operatorIdentitySurvey.getMockImplementation()!;
    network.gateway.operatorIdentitySurvey.mockImplementationOnce(async (input) => {
      await held;
      return await answer(input);
    });
    const moves = new IdentityMoves(db, network.gateway);
    await moves.survey();
    const first = moves.resumePending();
    await vi.waitFor(() => expect(network.gateway.operatorIdentitySurvey).toHaveBeenCalledOnce());
    await moves.resumePending();
    release();
    await first;
    expect(network.gateway.operatorIdentitySurvey).toHaveBeenCalledOnce();
    expect((await moves.status()).phase).toBe("ready");
  });

  it("drops a Ship the Gateway no longer holds, and finishes one that leaves before its move", async () => {
    const leaving = await ship("move-leaving");
    const staying = await ship("move-staying");
    const network = fakeGateway(new Map([[staying, survey(staying, { person: HANK })]]));
    const moves = new IdentityMoves(db, network.gateway);
    await moves.survey();
    await moves.resumePending();
    expect(network.surveyed).toContain(leaving);
    expect((await moves.status()).ships).toEqual({ total: 1, surveyed: 1, moved: 0 });

    await moves.apply();
    network.missing.add(staying);
    await moves.resumePending();
    expect(await moves.status()).toMatchObject({ phase: "moved", ships: { moved: 1 }, moved: { contacts: 0 } });
  });

  it("refuses to survey again once the move is applied", async () => {
    const settled = await ship("move-settled");
    const moves = new IdentityMoves(db, fakeGateway(new Map([[settled, survey(settled, {})]])).gateway);
    await moves.survey();
    await moves.resumePending();
    await moves.apply();
    await expect(moves.survey()).rejects.toMatchObject({
      message: "The move has been applied, so the Ships can't be surveyed again", status: 409,
    });
    expect((await moves.status()).phase).toBe("moving");
  });
});

describe("the move's operator page", () => {
  it("surveys and applies under the audit log, and asks the operator to confirm the move", async () => {
    const page = await ship("move-page");
    const surveys = new Map([[page, survey(page, { person: HANK, references: [FAR] })]]);
    const { http, insight } = adminStack(fakeGateway(surveys).gateway);
    const before = await http.handle(new Request(`${origin}/admin/identity-move`));
    expect(before?.status).toBe(200);
    const empty = await before!.text();
    expect(empty).toContain("No Ship has been surveyed yet");
    expect(empty).toContain('href="/admin/identity-move" aria-current="page"');

    const surveyed = await http.handle(form("/admin/identity-move/survey", { reason: "Release 0.8 cutover" }));
    expect([surveyed?.status, surveyed?.headers.get("location")]).toEqual([303, "/admin/identity-move"]);
    await new IdentityMoves(db, fakeGateway(surveys).gateway).resumePending();
    const ready = await (await http.handle(new Request(`${origin}/admin/identity-move`)))!.text();
    expect(ready).toContain("Every Ship has answered");
    expect(ready).toContain("Apply the move");

    const unconfirmed = await http.handle(form("/admin/identity-move/apply", { confirm: "yes" }));
    expect(unconfirmed?.status).toBe(400);
    expect(await unconfirmed!.text()).toContain("Type move to confirm the move");
    const applied = await http.handle(form("/admin/identity-move/apply", { confirm: "move" }));
    expect(applied?.status).toBe(303);

    const status = await http.handle(new Request(`${origin}/admin/api/identity-move`));
    expect(await status!.json()).toMatchObject({ phase: "moving", people: { named: 1, withDid: 0, withoutDid: 1 } });
    const again = await http.handle(new Request(`${origin}/admin/api/identity-move/survey`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
    }));
    expect([again?.status, await again!.json()]).toEqual([409, { error: "The move has been applied, so the Ships can't be surveyed again" }]);

    const audit = (await insight.audit.list({ page: 1 })).events.filter((event) => event.action.startsWith("deployment.identity-move."));
    expect(audit.map((event) => [event.action, event.outcome, event.reason])).toEqual([
      ["deployment.identity-move.survey", "error", null],
      ["deployment.identity-move.apply", "completed", null],
      ["deployment.identity-move.survey", "completed", "Release 0.8 cutover"],
    ]);
  });

  it("refuses a request body it doesn't understand, or one sent from another origin", async () => {
    const { http } = adminStack(fakeGateway(new Map()).gateway);
    const extra = await http.handle(new Request(`${origin}/admin/api/identity-move/survey`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ everyone: true }),
    }));
    expect([extra?.status, await extra!.json()]).toEqual([400, { error: "The request accepts only a reason and a confirmation" }]);
    const plain = await http.handle(new Request(`${origin}/admin/api/identity-move/apply`, {
      method: "POST", headers: { origin, "content-type": "text/plain" }, body: "move",
    }));
    expect([plain?.status, await plain!.json()]).toEqual([400, { error: "JSON body is required" }]);
    const elsewhere = await http.handle(form("/admin/identity-move/survey", {}, "https://elsewhere.example"));
    expect(elsewhere?.status).toBe(403);
    expect((await new IdentityMoves(db, undefined).status()).phase).toBe("not-started");
  });

  it("refuses an operator it does not admit", async () => {
    const http = new InstallationAdminHttp(adminStack().service, { allows: async () => false }, origin,
      { navigation: [IDENTITY_MOVE_NAVIGATION] }, undefined, undefined, new IdentityMoves(db, undefined));
    expect((await http.handle(new Request(`${origin}/admin/identity-move`)))?.status).toBe(403);
    expect((await http.handle(new Request(`${origin}/admin/api/identity-move`)))?.status).toBe(403);
    expect((await http.handle(form("/admin/identity-move/survey", {})))?.status).toBe(403);
  });
});

async function ship(handle: string, state = "active"): Promise<string> {
  const accounts = new AccountStore(db, "example.com");
  const principal = await accounts.createPrincipal({ email: `${handle}@example.com`, displayName: handle, verified: true });
  const { installationId } = await accounts.reserveInstallation({ principalId: principal.id, operationId: `operation-${handle}`, handle });
  await db.prepare("UPDATE installations SET state = ? WHERE id = ?").bind(state, installationId).run();
  return installationId;
}

function survey(installationId: string, input: Partial<Omit<OperatorIdentitySurvey, "version" | "installationId">>): OperatorIdentitySurvey {
  return {
    version: 1, installationId, person: input.person ?? null,
    references: (input.references ?? []).map(({ shipId, subjectId }) => ({ shipId, subjectId })),
    waiting: input.waiting ?? rows(0), otherAccounts: input.otherAccounts ?? 0,
  };
}

/** The Gateway's operator calls: each Ship moves a contact and a message per person it hears, and ends one contact. */
function fakeGateway(surveys: ReadonlyMap<string, OperatorIdentitySurvey>) {
  const surveyed: string[] = [];
  const moved = new Map<string, OperatorPersonDid[]>();
  const failNext = new Map<string, Error>();
  const missing = new Set<string>();
  const gateway = {
    operatorShipSnapshot: vi.fn<OperatorGatewayService["operatorShipSnapshot"]>(async () => ({ found: false })),
    operatorIdentitySurvey: vi.fn<OperatorGatewayService["operatorIdentitySurvey"]>(async ({ installationId }) => {
      surveyed.push(installationId);
      const failure = failNext.get(installationId);
      failNext.delete(installationId);
      if (failure) throw failure;
      const answer = surveys.get(installationId);
      return answer && !missing.has(installationId) ? { found: true, survey: answer } : { found: false };
    }),
    operatorIdentityMove: vi.fn<OperatorGatewayService["operatorIdentityMove"]>(async ({ installationId, people }) => {
      if (missing.has(installationId)) return { found: false };
      moved.set(installationId, people);
      return { found: true, move: {
        version: 1, installationId,
        moved: { contacts: people.length, blocks: 0, requests: 0, deliveries: 0, messages: people.length },
        ended: { contacts: 1, blocks: 0, requests: 0, deliveries: 0, messages: 0 },
      } };
    }),
  };
  return { gateway, surveyed, moved, failNext, missing };
}

function adminStack(gateway?: OperatorGatewayService) {
  const accounts = new AccountStore(db, "example.com");
  const onboarding = new InstallationOnboardingStore(db, accounts);
  const service = new InstallationAdminService(db, accounts, onboarding,
    { id: "principal_identity_move_operator", email: "operator@gsv.invalid", displayName: "Operator" }, {});
  const insight = new ShipInsight(db, { gateway });
  const http = new InstallationAdminHttp(service, new CloudflareInstallationAdminAccess({ environment: "development", origin }), origin,
    { navigation: [IDENTITY_MOVE_NAVIGATION] }, undefined, insight, new IdentityMoves(db, gateway));
  return { service, http, insight };
}

function form(path: string, values: Record<string, string>, from = origin): Request {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin: from }, body: new URLSearchParams(values) });
}
